// packages/core/src/readiness/invest.ts — deterministic INVEST report for a raw issue in factory check (#1731). Pure — no I/O.
import { assessAcceptanceCriteria } from './criteria.js';
import type { InvestLetter } from './decompose.js';
import { extractIssueSections, findSection } from './index.js';
import { checkIssueSize } from './size.js';

export type IssueInvestStatus = 'pass' | 'warn' | 'not-checked';
export type IssueDependencyState = 'open' | 'closed' | 'unknown';

export interface IssueInvestFinding {
  letter: InvestLetter;
  status: IssueInvestStatus;
  reason: string;
}

export interface IssueInvestReport {
  /** Always six findings, in I-N-V-E-S-T order. */
  findings: IssueInvestFinding[];
}

/** A Problem statement shorter than this is too thin to say who is affected and why. */
export const MIN_PROBLEM_STATEMENT_CHARS = 80;

const DEPENDENCY_RE = /\b(?:depends on|after|blocked by)\s+#(\d+)\b/gi;
const VALUE_CUE_RE = /\b(?:because|so that|so|why|in order to|otherwise|cannot|can't|unable|matters?)\b/i;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const NEEDS_MODEL = 'needs model judgement';

function stripFences(body: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join('\n');
}

/** Issue numbers cited by "depends on / after / blocked by #N", unique, first-seen order. Fenced code is ignored. */
export function findIssueDependencies(body: string): number[] {
  const seen = new Set<number>();
  for (const m of stripFences(body ?? '').matchAll(DEPENDENCY_RE)) seen.add(Number(m[1]));
  return [...seen];
}

const refs = (nums: number[]): string => nums.map((n) => `#${n}`).join(', ');

function assessValuable(sections: Map<string, string>): IssueInvestFinding {
  const ps = findSection(sections, 'Problem statement')?.trim() ?? '';
  const warn = (reason: string): IssueInvestFinding => ({ letter: 'valuable', status: 'warn', reason });
  if (ps === '') return warn('no Problem statement');
  if (ps.length < MIN_PROBLEM_STATEMENT_CHARS) {
    return warn(
      `Problem statement is short (${ps.length} < ${MIN_PROBLEM_STATEMENT_CHARS} chars) — say who is affected and why it matters`,
    );
  }
  if (!VALUE_CUE_RE.test(ps)) {
    return warn('Problem statement does not say why it matters (no because/so/why clause)');
  }
  return { letter: 'valuable', status: 'pass', reason: 'Problem statement says who is affected and why' };
}

function assessTestable(ac: string): IssueInvestFinding {
  const findings = assessAcceptanceCriteria(ac);
  const warn = (reason: string): IssueInvestFinding => ({ letter: 'testable', status: 'warn', reason });
  if (findings.length === 0) return warn('no acceptance criteria');
  const empty = findings.find((f) => f.grade === 'empty');
  if (empty) return warn(`criterion ${empty.index} is empty`);
  const vague = findings.find((f) => f.grade === 'unstructured' && !f.observable);
  if (vague) return warn(`criterion ${vague.index} has no observable outcome`);
  return { letter: 'testable', status: 'pass', reason: `${findings.length} criteria are checkable` };
}

export function assessIssueInvest(
  sections: Map<string, string>,
  dependencyStates: ReadonlyMap<number, IssueDependencyState> = new Map(),
): IssueInvestReport {
  const deps = findIssueDependencies([...sections.values()].join('\n'));
  const open = deps.filter((n) => dependencyStates.get(n) === 'open');
  const unknown = deps.filter((n) => {
    const s = dependencyStates.get(n);
    return s === undefined || s === 'unknown';
  });
  let independent: IssueInvestFinding;
  if (open.length > 0) {
    independent = { letter: 'independent', status: 'warn', reason: `depends on open ${refs(open)}` };
  } else if (unknown.length > 0) {
    independent = { letter: 'independent', status: 'warn', reason: `could not check state of ${refs(unknown)}` };
  } else if (deps.length > 0) {
    independent = { letter: 'independent', status: 'pass', reason: `dependencies closed: ${refs(deps)}` };
  } else {
    independent = { letter: 'independent', status: 'pass', reason: 'no dependencies named' };
  }

  const ac = findSection(sections, 'Acceptance criteria') ?? '';
  const size = checkIssueSize({ inScope: findSection(sections, 'In scope') ?? '', acceptanceCriteria: ac });
  const small: IssueInvestFinding = size.sizeOk
    ? { letter: 'small', status: 'pass', reason: 'within the size gate' }
    : { letter: 'small', status: 'warn', reason: size.reason ?? 'too big' };

  return {
    findings: [
      independent,
      { letter: 'negotiable', status: 'not-checked', reason: NEEDS_MODEL },
      assessValuable(sections),
      { letter: 'estimable', status: 'not-checked', reason: NEEDS_MODEL },
      small,
      assessTestable(ac),
    ],
  };
}

export function gradeIssueInvest(
  body: string,
  dependencyStates?: ReadonlyMap<number, IssueDependencyState>,
): IssueInvestReport {
  return assessIssueInvest(extractIssueSections(body ?? ''), dependencyStates);
}
