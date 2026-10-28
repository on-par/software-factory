// packages/core/src/kpis/tier-evidence.ts — Trust-tier promotion evidence for the classifier report (ADR-0148, #1957).

import type { TrustTier } from '../config/repo.js';
import { type ClassifierOutcomeRecord, summarizeClassifierOutcomes } from './classifier-outcomes.js';

export type TierCriterionName = 'coverage' | 'mutation' | 'humanIntervention' | 'slips';
export type TierCriterionStatus = 'met' | 'unmet' | 'unknown';

export interface TierEvidenceLimits {
  /** Highest acceptable class-A slip rate or rule-of-three bound. */
  maxSlipRate: number;
  /** Highest acceptable class-A human-intervention rate or rule-of-three bound. */
  maxHumanInterventionRate: number;
  /** Coverage and mutation evidence older than this is unknown (two weekly runs, like scripts/mutation-summary.ts). */
  maxEvidenceAgeDays: number;
}

export const DEFAULT_TIER_EVIDENCE_LIMITS: TierEvidenceLimits = {
  maxSlipRate: 0.05,
  maxHumanInterventionRate: 0.2,
  maxEvidenceAgeDays: 14,
};

/** What `npm run coverage-ratchet -- --out <file>` writes. */
export interface CoverageRatchetEvidence {
  ok: boolean;
  measuredAt: string;
}

export interface MutationPackageEvidence {
  package: string;
  score: number | 'unknown';
  floor: number | null;
  status: TierCriterionStatus;
}

export interface RateEvidence {
  /** Merged class-A PRs whose defect window has closed (ADR-0126 evidence count). */
  n: number;
  events: number;
  /** events / n; null when n is 0. */
  rate: number | null;
  /** min(1, 3/n) when events is 0 and n > 0; else null. */
  upperBound: number | null;
  limit: number;
  status: TierCriterionStatus;
}

export interface TierEvidenceReport {
  /** 'unknown' when the repo config failed to load. */
  configuredTier: TrustTier | 'unknown';
  /** Why the repo config failed to load; null when it loaded. */
  configError: string | null;
  coverage: { status: TierCriterionStatus; ratchet: 'green' | 'red' | 'unknown'; measuredAt: string | null };
  mutation: { status: TierCriterionStatus; packages: MutationPackageEvidence[] };
  humanIntervention: RateEvidence & { caveat: string };
  slips: RateEvidence;
  eligibleFor: TrustTier | 'none';
  unmet: TierCriterionName[];
}

export interface TierEvidenceInputs {
  configuredTier: TrustTier | 'unknown';
  /** Set when the repo config failed to load; the report then names no eligible tier. */
  configError?: string;
  records: ClassifierOutcomeRecord[];
  /** Raw mutation-summary.json text (#805/#2130 format); undefined when the file is absent. */
  mutationSummaryText: string | undefined;
  /** Raw coverage-ratchet.json text; undefined when the file is absent. */
  coverageEvidenceText: string | undefined;
  now: Date;
  limits?: Partial<TierEvidenceLimits>;
}

const DAY_MS = 86_400_000;

const HUMAN_INTERVENTION_CAVEAT =
  'Human intervention counts class-A PRs a human edited before merge, over merged PRs whose defect window has closed. Approvals the tier requires are not counted. Edits made outside GitHub are not seen.';

const NEXT_TIER: Record<TrustTier | 'unknown', TrustTier | null> = { T0: 'T1', T1: 'T2', T2: null, unknown: null };

export function coverageRatchetEvidence(ok: boolean, measuredAt: Date): CoverageRatchetEvidence {
  return { ok, measuredAt: measuredAt.toISOString() };
}

function isFresh(iso: string, now: Date, maxAgeDays: number): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const age = now.getTime() - t;
  return age >= 0 && age <= maxAgeDays * DAY_MS;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined || text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function coverageFrom(text: string | undefined, now: Date, maxAge: number): TierEvidenceReport['coverage'] {
  const unknown = (measuredAt: string | null) => ({
    status: 'unknown' as const,
    ratchet: 'unknown' as const,
    measuredAt,
  });
  const raw = parseJson(text);
  if (!raw || typeof raw !== 'object') return unknown(null);
  const { ok, measuredAt } = raw as { ok?: unknown; measuredAt?: unknown };
  const stamp = typeof measuredAt === 'string' && !Number.isNaN(Date.parse(measuredAt)) ? measuredAt : null;
  if (typeof ok !== 'boolean' || stamp === null || !isFresh(stamp, now, maxAge)) return unknown(stamp);
  return ok
    ? { status: 'met', ratchet: 'green', measuredAt: stamp }
    : { status: 'unmet', ratchet: 'red', measuredAt: stamp };
}

function isPercent(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
}

function mutationFrom(text: string | undefined, now: Date, maxAge: number): TierEvidenceReport['mutation'] {
  const none = { status: 'unknown' as const, packages: [] };
  const raw = parseJson(text);
  if (!raw || typeof raw !== 'object') return none;
  const entries = (raw as { packages?: unknown }).packages;
  if (!Array.isArray(entries)) return none;
  const packages: MutationPackageEvidence[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') return none;
    const { package: name, score, floor, measuredAt } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || name === '' || !isPercent(score)) return none;
    if (floor !== null && !isPercent(floor)) return none;
    if (typeof measuredAt !== 'string' || Number.isNaN(Date.parse(measuredAt))) return none;
    const fresh = isFresh(measuredAt, now, maxAge);
    let status: TierCriterionStatus = 'unknown';
    if (fresh && floor !== null) status = score >= floor ? 'met' : 'unmet';
    packages.push({ package: name, score: fresh ? score : 'unknown', floor, status });
  }
  let status: TierCriterionStatus = 'met';
  if (packages.length === 0 || packages.some((p) => p.status === 'unknown')) status = 'unknown';
  else if (packages.some((p) => p.status === 'unmet')) status = 'unmet';
  return { status, packages };
}

function rateFrom(n: number, events: number, limit: number): RateEvidence {
  const rate = n > 0 ? events / n : null;
  const upperBound = n > 0 && events === 0 ? Math.min(1, 3 / n) : null;
  const bound = upperBound ?? rate;
  let status: TierCriterionStatus = 'unknown';
  if (n > 0 && bound !== null) status = bound <= limit ? 'met' : 'unmet';
  return { n, events, rate, upperBound, limit, status };
}

export function buildTierEvidence(inputs: TierEvidenceInputs): TierEvidenceReport {
  const limits = { ...DEFAULT_TIER_EVIDENCE_LIMITS, ...inputs.limits };
  const a = summarizeClassifierOutcomes(inputs.records).classes.A;
  const slips = rateFrom(a.closed, a.slipped, limits.maxSlipRate);
  const evidenceSet = inputs.records.filter((r) => r.modelClass === 'A' && r.merged && r.defectWindowClosed);
  const edited = evidenceSet.filter((r) => r.humanEdited).length;
  const humanIntervention = {
    ...rateFrom(evidenceSet.length, edited, limits.maxHumanInterventionRate),
    caveat: HUMAN_INTERVENTION_CAVEAT,
  };
  const coverage = coverageFrom(inputs.coverageEvidenceText, inputs.now, limits.maxEvidenceAgeDays);
  const mutation = mutationFrom(inputs.mutationSummaryText, inputs.now, limits.maxEvidenceAgeDays);
  const statuses: [TierCriterionName, TierCriterionStatus][] = [
    ['coverage', coverage.status],
    ['mutation', mutation.status],
    ['humanIntervention', humanIntervention.status],
    ['slips', slips.status],
  ];
  const unmet = statuses.filter(([, s]) => s !== 'met').map(([name]) => name);
  const next = NEXT_TIER[inputs.configuredTier];
  return {
    configuredTier: inputs.configuredTier,
    configError: inputs.configError ?? null,
    coverage,
    mutation,
    humanIntervention,
    slips,
    eligibleFor: next !== null && unmet.length === 0 ? next : 'none',
    unmet,
  };
}

function pct(percent: number): string {
  return `${Number(percent.toFixed(1))}%`;
}

function frac(rate: number): string {
  return pct(rate * 100);
}

function rateText(e: RateEvidence): string {
  if (e.n === 0) return 'unknown (0 merged PRs with closed defect window)';
  if (e.events === 0 && e.upperBound !== null) {
    return `0 of ${e.n}, ≤ ${frac(e.upperBound)} (rule of three), limit ${frac(e.limit)}`;
  }
  return `${e.events} of ${e.n}, observed ${frac(e.rate ?? 0)}, limit ${frac(e.limit)}`;
}

export function formatTierEvidence(report: TierEvidenceReport): string[] {
  const lines = ['Trust tier evidence (ADR-0148, read-only):'];
  lines.push(
    report.configError === null
      ? `configured tier: ${report.configuredTier}`
      : `configured tier: unknown (repo config invalid: ${report.configError})`,
  );
  lines.push(
    `coverage ratchet: ${report.coverage.ratchet}${report.coverage.measuredAt ? ` (measured ${report.coverage.measuredAt})` : ''}`,
  );
  lines.push(`mutation: ${report.mutation.status}`);
  if (report.mutation.packages.length === 0) {
    lines.push('  no mutation summary (mutation-summary.json absent, stale or invalid)');
  }
  for (const p of report.mutation.packages) {
    const score = p.score === 'unknown' ? 'unknown' : pct(p.score);
    lines.push(`  ${p.package}: ${score} vs floor ${p.floor === null ? 'none' : pct(p.floor)} — ${p.status}`);
  }
  const hi = report.humanIntervention;
  lines.push(`human intervention: ${rateText(hi)} — ${hi.status}`, `  caveat: ${hi.caveat}`);
  lines.push(`slips: ${rateText(report.slips)} — ${report.slips.status}`);
  let last = `eligible for: ${report.eligibleFor}`;
  if (report.unmet.length > 0) last += ` — unmet: ${report.unmet.join(', ')}`;
  if (report.configuredTier === 'T2') last += ' (T2 is the top tier)';
  lines.push(last);
  return lines;
}
