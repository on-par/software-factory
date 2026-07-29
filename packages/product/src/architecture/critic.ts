// packages/product/src/architecture/critic.ts — epic-design critic + bounded rework loop (#478).

import { DesignArtifactSchema } from '@on-par/contracts';

import type { IntentDoc } from '../intent/index.js';
import type { JudgeStopReason, RubricCheck } from '../judge/index.js';
import type { EpicAdr } from './adrs.js';
import type { ArchitectureConstraint, EpicArchitecture } from './design.js';

export type DesignCriticOutcome = 'pass' | 'rework';

/** The critic's verdict on one epic-architecture version. */
export interface DesignCriticVerdict {
  verdict: DesignCriticOutcome;
  /** ADR labels the design violates (missing or stale citations); empty on pass. Sorted, de-duplicated. */
  violatedAdrs: readonly string[];
  /** Non-empty. 'All N checks passed.' or the failed checks' notes joined with '; '. */
  rationale: string;
  checks: readonly RubricCheck[];
}

/** The critic seam — an AI-backed critic plugs in here (async allowed). */
export type EpicDesignCritic = (
  architecture: EpicArchitecture,
  doc: IntentDoc,
  adrs: readonly EpicAdr[],
) => DesignCriticVerdict | Promise<DesignCriticVerdict>;

/** The reworker seam — proposes an improved architecture from a rework verdict. */
export type EpicDesignReworker = (
  architecture: EpicArchitecture,
  verdict: DesignCriticVerdict,
  doc: IntentDoc,
  adrs: readonly EpicAdr[],
) => EpicArchitecture | Promise<EpicArchitecture>;

export interface CritiquedDesign {
  /** Best version seen (fewest failed checks). */
  architecture: EpicArchitecture;
  /** Verdict for that version. */
  verdict: DesignCriticVerdict;
  /** Rework rounds actually executed. */
  iterations: number;
  stopReason: JudgeStopReason;
  /** Failed-check count for the initial critique, then one entry per rework round. */
  failedCheckHistory: readonly number[];
}

export interface DesignCriticDeps {
  critic?: EpicDesignCritic;
  rework?: EpicDesignReworker;
}

export interface DesignCriticOptions {
  maxIterations?: number;
}

export const DEFAULT_MAX_CRITIC_ITERATIONS = 3;

function condense(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function resolveMaxIterations(options: DesignCriticOptions): number {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_CRITIC_ITERATIONS;
  if (!Number.isInteger(maxIterations) || maxIterations < 0) {
    throw new Error('design critic: maxIterations must be a non-negative integer');
  }
  return maxIterations;
}

/** Six equally-weighted checks against the approved intent doc and the active ADRs. Pure, deterministic. */
export function critiqueEpicDesignAgainstAdrs(
  architecture: EpicArchitecture,
  doc: IntentDoc,
  adrs: readonly EpicAdr[],
): DesignCriticVerdict {
  const activeLabels = new Set(adrs.map((adr) => adr.label));

  const missingAdrs = adrs.filter((adr) => !architecture.constraints.some((c) => c.adr === adr.label));
  const staleConstraints = architecture.constraints.filter((c) => c.adr !== undefined && !activeLabels.has(c.adr));
  const staleLabels = [...new Set(staleConstraints.map((c) => c.adr as string))];

  const missingOpenQuestions = architecture.deviations.filter(
    (d) => !architecture.artifact.openQuestions.includes(`needs a new ADR: ${d.text}`),
  );

  const missingContractLines = architecture.constraints.filter(
    (c) => !architecture.artifact.behaviorContract.includes(c.text),
  );

  const checks: readonly RubricCheck[] = [
    {
      id: 'intent-approved',
      label: 'The design was critiqued against an approved intent doc',
      passed: doc.status === 'approved',
      note:
        doc.status === 'approved'
          ? 'the design was critiqued against an approved intent doc'
          : 'the design was critiqued against an unapproved intent doc (human gate #1 not passed)',
    },
    {
      id: 'adrs-honored',
      label: 'Every active ADR is carried as a constraint',
      passed: missingAdrs.length === 0,
      note:
        missingAdrs.length === 0
          ? 'every active ADR is carried as a constraint'
          : `design contradicts active ADR(s) it does not carry as constraints: ${missingAdrs.map((a) => a.label).join(', ')}`,
    },
    {
      id: 'adr-citations-active',
      label: 'Every ADR-backed constraint cites an active ADR',
      passed: staleLabels.length === 0,
      note:
        staleLabels.length === 0
          ? 'every ADR-backed constraint cites an active ADR'
          : `design leans on retired/unknown ADR(s): ${staleLabels.join(', ')}`,
    },
    {
      id: 'deviations-disclosed',
      label: 'Every deviation is disclosed as an open question',
      passed: missingOpenQuestions.length === 0,
      note:
        missingOpenQuestions.length === 0
          ? 'every deviation is disclosed as an open question'
          : `deviations missing from openQuestions: ${missingOpenQuestions.map((d) => d.text).join(', ')}`,
    },
    {
      id: 'contract-mirrors-constraints',
      label: 'The behavior contract mirrors the constraints',
      passed: missingContractLines.length === 0,
      note:
        missingContractLines.length === 0
          ? 'the behavior contract mirrors the constraints'
          : `constraints missing from behaviorContract: ${missingContractLines.map((c) => c.text).join(', ')}`,
    },
    {
      id: 'verification-grounded',
      label: 'A non-empty verification plan grounds the design',
      passed: architecture.artifact.verificationPlan.length > 0,
      note:
        architecture.artifact.verificationPlan.length > 0
          ? 'the verification plan is non-empty'
          : 'verificationPlan is empty',
    },
  ];

  const violatedAdrs = [...new Set([...missingAdrs.map((a) => a.label), ...staleLabels])].sort();
  const failed = checks.filter((c) => !c.passed);
  const verdict: DesignCriticOutcome = failed.length === 0 ? 'pass' : 'rework';
  const rationale = failed.length === 0 ? `All ${checks.length} checks passed.` : failed.map((c) => c.note).join('; ');

  return { verdict, violatedAdrs, rationale, checks };
}

/** The deterministic reworker: fixes what it can, leaves the rest for the loop to judge honestly. */
export function reworkEpicArchitectureMechanically(
  architecture: EpicArchitecture,
  verdict: DesignCriticVerdict,
  _doc: IntentDoc,
  adrs: readonly EpicAdr[],
): EpicArchitecture {
  const failedIds = new Set(verdict.checks.filter((c) => !c.passed).map((c) => c.id));
  if (failedIds.size === 0) {
    return architecture;
  }

  let constraints: readonly ArchitectureConstraint[] = architecture.constraints;
  let deviations = architecture.deviations;
  let openQuestions = architecture.artifact.openQuestions;
  let fixed = false;

  if (failedIds.has('adrs-honored')) {
    const missingAdrs = adrs.filter((adr) => !constraints.some((c) => c.adr === adr.label));
    const newConstraints: ArchitectureConstraint[] = missingAdrs.map((adr) => ({
      text: `${adr.label} — ${adr.title}: ${condense(adr.decision, 300)}`,
      adr: adr.label,
    }));
    constraints = [...newConstraints, ...constraints];
    fixed = true;
  }

  if (failedIds.has('adr-citations-active')) {
    const activeLabels = new Set(adrs.map((adr) => adr.label));
    const newDeviations = [...deviations];
    let newOpenQuestions = [...openQuestions];

    constraints = constraints.map((c) => {
      if (c.adr === undefined || activeLabels.has(c.adr)) {
        return c;
      }
      newDeviations.push({ subject: c.adr.toLowerCase(), text: c.text });
      const openQuestion = `needs a new ADR: ${c.text}`;
      if (!newOpenQuestions.includes(openQuestion)) {
        newOpenQuestions = [...newOpenQuestions, openQuestion];
      }
      return { text: c.text };
    });

    deviations = newDeviations;
    openQuestions = newOpenQuestions;
    fixed = true;
  }

  if (failedIds.has('deviations-disclosed')) {
    for (const deviation of deviations) {
      const openQuestion = `needs a new ADR: ${deviation.text}`;
      if (!openQuestions.includes(openQuestion)) {
        openQuestions = [...openQuestions, openQuestion];
      }
    }
    fixed = true;
  }

  let behaviorContract = architecture.artifact.behaviorContract;
  if (failedIds.has('contract-mirrors-constraints')) {
    behaviorContract = constraints.map((c) => c.text);
    fixed = true;
  }

  if (!fixed) {
    return architecture;
  }

  const artifact = DesignArtifactSchema.parse({ ...architecture.artifact, behaviorContract, openQuestions });

  return { artifact, constraints, deviations };
}

/**
 * Critique one epic architecture, reworking it while it fails checks. Structurally bounded: the only
 * loop is the for-loop over 1..maxIterations, so no injected critic/reworker (however adversarial) can
 * make this run indefinitely.
 */
export async function critiqueEpicDesign(
  architecture: EpicArchitecture,
  doc: IntentDoc,
  adrs: readonly EpicAdr[],
  deps: DesignCriticDeps = {},
  options: DesignCriticOptions = {},
): Promise<CritiquedDesign> {
  const critic = deps.critic ?? critiqueEpicDesignAgainstAdrs;
  const rework = deps.rework ?? reworkEpicArchitectureMechanically;
  const maxIterations = resolveMaxIterations(options);
  const failedCount = (v: DesignCriticVerdict) => v.checks.filter((c) => !c.passed).length;

  let best = { architecture, verdict: await critic(architecture, doc, adrs) };
  const failedCheckHistory: number[] = [failedCount(best.verdict)];

  if (best.verdict.verdict === 'pass') {
    return {
      architecture: best.architecture,
      verdict: best.verdict,
      iterations: 0,
      stopReason: 'passed',
      failedCheckHistory,
    };
  }

  for (let i = 1; i <= maxIterations; i++) {
    const candidate = await rework(best.architecture, best.verdict, doc, adrs);
    const verdict = await critic(candidate, doc, adrs);
    failedCheckHistory.push(failedCount(verdict));

    if (failedCount(verdict) >= failedCount(best.verdict)) {
      return {
        architecture: best.architecture,
        verdict: best.verdict,
        iterations: i,
        stopReason: 'no-improvement',
        failedCheckHistory,
      };
    }

    best = { architecture: candidate, verdict };
    if (verdict.verdict === 'pass') {
      return {
        architecture: best.architecture,
        verdict: best.verdict,
        iterations: i,
        stopReason: 'passed',
        failedCheckHistory,
      };
    }
  }

  return {
    architecture: best.architecture,
    verdict: best.verdict,
    iterations: maxIterations,
    stopReason: 'max-iterations',
    failedCheckHistory,
  };
}
