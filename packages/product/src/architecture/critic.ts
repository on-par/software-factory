// packages/product/src/architecture/critic.ts — epic-design critic, Judge pattern reused (#478).

import { DesignArtifactSchema } from '@on-par/contracts';

import type { IntentDoc } from '../intent/index.js';
import { DEFAULT_MAX_REWORK_ITERATIONS, type RubricCheck } from '../judge/index.js';
import type { EpicAdr } from './adrs.js';
import {
  adrConstraintOf,
  findBackingAdr,
  type ArchitectureConstraint,
  type ArchitectureDecision,
  type EpicArchitecture,
} from './design.js';

/** The critic's verdict on one epic-architecture version. */
export interface CriticVerdict {
  /** 'pass' iff every check passed; otherwise 'rework'. */
  verdict: 'pass' | 'rework';
  /** Integer 0-100: share of checks passed (rubric-style). */
  score: number;
  /** Non-empty. 'All N checks passed.' or the failed checks' notes joined with '; '. */
  rationale: string;
  checks: readonly RubricCheck[];
  /** Labels of active ADRs the architecture ignores or re-decides; deduped, sorted. */
  violatedAdrs: readonly string[];
}

/** The critic seam — an AI-backed critic plugs in here (async allowed). */
export type EpicDesignCritic = (
  architecture: EpicArchitecture,
  doc: IntentDoc,
  adrs: readonly EpicAdr[],
) => CriticVerdict | Promise<CriticVerdict>;

/** The reworker seam — proposes an improved architecture from a failing verdict. */
export type EpicDesignReworker = (
  architecture: EpicArchitecture,
  verdict: CriticVerdict,
  doc: IntentDoc,
  adrs: readonly EpicAdr[],
) => EpicArchitecture | Promise<EpicArchitecture>;

export interface EpicDesignCriticDeps {
  critic?: EpicDesignCritic;
  rework?: EpicDesignReworker;
}

export interface EpicDesignCriticOptions {
  maxIterations?: number;
}

export type CriticStopReason = 'passed' | 'no-improvement' | 'max-iterations';

export interface EpicDesignCritique {
  /** Best-scoring version seen. */
  architecture: EpicArchitecture;
  /** Verdict for that version. */
  verdict: CriticVerdict;
  /** Rework rounds actually executed. */
  iterations: number;
  stopReason: CriticStopReason;
  /** Initial score first, then one entry per rework round. */
  scoreHistory: readonly number[];
}

function resolveMaxIterations(options: EpicDesignCriticOptions): number {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_REWORK_ITERATIONS;
  if (!Number.isInteger(maxIterations) || maxIterations < 0) {
    throw new Error('epic-design critic: maxIterations must be a non-negative integer');
  }
  return maxIterations;
}

/** Five equally-weighted checks against the approved intent doc and the active ADRs. Pure, deterministic. */
export function critiqueEpicArchitecture(
  architecture: EpicArchitecture,
  doc: IntentDoc,
  adrs: readonly EpicAdr[],
): CriticVerdict {
  const missing = adrs.map((a) => a.label).filter((label) => !architecture.constraints.some((c) => c.adr === label));

  const conflicts: { deviation: ArchitectureDecision; backing: EpicAdr }[] = [];
  for (const deviation of architecture.deviations) {
    const backing = findBackingAdr(deviation.subject, adrs);
    if (backing !== undefined) {
      conflicts.push({ deviation, backing });
    }
  }

  const undeclared = architecture.deviations.filter(
    (d) => !architecture.artifact.openQuestions.includes(`needs a new ADR: ${d.text}`),
  );

  const checks: readonly RubricCheck[] = [
    {
      id: 'intent-approved',
      label: 'The intent doc is approved (human gate #1)',
      passed: doc.status === 'approved',
      note:
        doc.status === 'approved'
          ? 'the intent doc is approved'
          : 'the intent doc is a draft — the critic needs human gate #1',
    },
    {
      id: 'adrs-covered',
      label: 'Every active ADR is carried as a constraint',
      passed: missing.length === 0,
      note:
        missing.length === 0
          ? 'every active ADR is carried as a constraint'
          : `active ADRs missing from the constraints: ${missing.join(', ')}`,
    },
    {
      id: 'no-adr-conflicts',
      label: 'No deviation re-decides ground an active ADR covers',
      passed: conflicts.length === 0,
      note:
        conflicts.length === 0
          ? 'no deviation re-decides ground an active ADR covers'
          : conflicts.map((c) => `"${c.deviation.text}" conflicts with ${c.backing.label}`).join('; '),
    },
    {
      id: 'deviations-declared',
      label: 'Every deviation is declared as an open question',
      passed: undeclared.length === 0,
      note:
        undeclared.length === 0
          ? 'every deviation is declared as an open question'
          : `deviations not declared as open questions: ${undeclared.map((d) => d.text).join(', ')}`,
    },
    {
      id: 'verification-planned',
      label: 'The architecture carries a non-empty verification plan',
      passed: architecture.artifact.verificationPlan.length > 0,
      note:
        architecture.artifact.verificationPlan.length > 0
          ? 'the architecture carries a non-empty verification plan'
          : 'verificationPlan is empty',
    },
  ];

  const passedCount = checks.filter((c) => c.passed).length;
  const score = Math.round((passedCount / checks.length) * 100);
  const failed = checks.filter((c) => !c.passed);
  const verdict: CriticVerdict['verdict'] = failed.length === 0 ? 'pass' : 'rework';
  const rationale = failed.length === 0 ? `All ${checks.length} checks passed.` : failed.map((c) => c.note).join('; ');
  const violatedAdrs = [...new Set([...missing, ...conflicts.map((c) => c.backing.label)])].sort();

  return { verdict, score, rationale, checks, violatedAdrs };
}

/** The deterministic critic-side reworker: fixes what it can, leaves the rest for the loop to judge honestly. */
export function reworkArchitectureMechanically(
  architecture: EpicArchitecture,
  verdict: CriticVerdict,
  _doc: IntentDoc,
  adrs: readonly EpicAdr[],
): EpicArchitecture {
  const failedIds = new Set(verdict.checks.filter((c) => !c.passed).map((c) => c.id));
  const fixable = ['adrs-covered', 'no-adr-conflicts', 'deviations-declared'];
  if (!fixable.some((id) => failedIds.has(id))) {
    return architecture;
  }

  let constraints = [...architecture.constraints];
  let deviations = [...architecture.deviations];

  if (failedIds.has('no-adr-conflicts')) {
    deviations = deviations.filter((d) => {
      const backing = findBackingAdr(d.subject, adrs);
      if (backing === undefined) {
        return true;
      }
      constraints = constraints.map((c) =>
        c.text === d.text && c.adr === undefined ? { text: `${d.text} (per ${backing.label})`, adr: backing.label } : c,
      );
      return false;
    });
  }

  if (failedIds.has('adrs-covered')) {
    const missingAdrs = adrs.filter((adr) => !constraints.some((c) => c.adr === adr.label));
    constraints = [...missingAdrs.map(adrConstraintOf), ...constraints];
  }

  const behaviorContract = constraints.map((c: ArchitectureConstraint) => c.text);
  const openQuestions = [
    ...architecture.artifact.openQuestions.filter((q) => !q.startsWith('needs a new ADR: ')),
    ...deviations.map((d) => `needs a new ADR: ${d.text}`),
  ];
  const artifact = DesignArtifactSchema.parse({ ...architecture.artifact, behaviorContract, openQuestions });

  return { artifact, constraints, deviations };
}

/**
 * Critique one epic architecture, reworking it while it fails checks. Structurally bounded: the only
 * loop is the for-loop over 1..maxIterations, so no injected critic/reworker (however adversarial) can
 * make this run indefinitely.
 */
export async function runEpicDesignCritic(
  architecture: EpicArchitecture,
  doc: IntentDoc,
  adrs: readonly EpicAdr[],
  deps: EpicDesignCriticDeps = {},
  options: EpicDesignCriticOptions = {},
): Promise<EpicDesignCritique> {
  const critic = deps.critic ?? critiqueEpicArchitecture;
  const rework = deps.rework ?? reworkArchitectureMechanically;
  const maxIterations = resolveMaxIterations(options);

  let best = { architecture, verdict: await critic(architecture, doc, adrs) };
  const scoreHistory: number[] = [best.verdict.score];

  if (best.verdict.verdict === 'pass') {
    return {
      architecture: best.architecture,
      verdict: best.verdict,
      iterations: 0,
      stopReason: 'passed',
      scoreHistory,
    };
  }

  for (let i = 1; i <= maxIterations; i++) {
    const candidate = await rework(best.architecture, best.verdict, doc, adrs);
    const verdict = await critic(candidate, doc, adrs);
    scoreHistory.push(verdict.score);

    if (verdict.score <= best.verdict.score) {
      return {
        architecture: best.architecture,
        verdict: best.verdict,
        iterations: i,
        stopReason: 'no-improvement',
        scoreHistory,
      };
    }

    best = { architecture: candidate, verdict };
    if (verdict.verdict === 'pass') {
      return {
        architecture: best.architecture,
        verdict: best.verdict,
        iterations: i,
        stopReason: 'passed',
        scoreHistory,
      };
    }
  }

  return {
    architecture: best.architecture,
    verdict: best.verdict,
    iterations: maxIterations,
    stopReason: 'max-iterations',
    scoreHistory,
  };
}
