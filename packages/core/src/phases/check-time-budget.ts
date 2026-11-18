import type { CheckSummary } from '../types/index.js';

export const RUN_DEADLINE_ENV = 'FACTORY_RUN_DEADLINE_AT';

export const DEFAULT_VERIFY_MINUTES = 10;
export const DEFAULT_REWORK_BUILD_MINUTES = 10;
export const DEFAULT_SAFETY_MARGIN_MINUTES = 2;

const MINUTE_MS = 60_000;
const MAX_FAILURE_DETAIL = 400;

export interface TimeBudgetSettings {
  verifyMinutes?: number;
  reworkBuildMinutes?: number;
  safetyMarginMinutes?: number;
}

export type TimeBudgetStep = 'rerun' | 'rework';

export interface TimeBudgetFit {
  fits: boolean;
  neededMs: number;
  leftMs: number;
  stopped?: true;
}

export interface TimeBudget {
  recordVerify(ms: number): void;
  fit(step: TimeBudgetStep): TimeBudgetFit;
}

export function parseRunDeadline(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function createTimeBudget(opts: {
  deadlineAtMs: number | undefined;
  now: () => number;
  settings?: TimeBudgetSettings;
  stopRequested?: () => boolean;
}): TimeBudget {
  const { deadlineAtMs, now, settings = {}, stopRequested } = opts;
  const defaultVerifyMs = (settings.verifyMinutes ?? DEFAULT_VERIFY_MINUTES) * MINUTE_MS;
  const reworkBuildMs = (settings.reworkBuildMinutes ?? DEFAULT_REWORK_BUILD_MINUTES) * MINUTE_MS;
  const marginMs = (settings.safetyMarginMinutes ?? DEFAULT_SAFETY_MARGIN_MINUTES) * MINUTE_MS;
  let verifyMs: number | undefined;
  return {
    recordVerify(ms) {
      verifyMs = verifyMs === undefined ? ms : Math.max(verifyMs, ms);
    },
    fit(step) {
      if (stopRequested?.()) return { fits: false, neededMs: 0, leftMs: 0, stopped: true };
      if (deadlineAtMs === undefined) return { fits: true, neededMs: 0, leftMs: Infinity };
      const verify = verifyMs ?? defaultVerifyMs;
      const neededMs = (step === 'rework' ? reworkBuildMs : 0) + verify + marginMs;
      const leftMs = deadlineAtMs - now();
      return { fits: neededMs <= leftMs, neededMs, leftMs };
    },
  };
}

function minutes(ms: number): number {
  return Math.max(0, Math.ceil(ms / MINUTE_MS));
}

export function describeTimeBudgetSkip(step: TimeBudgetStep, fit: TimeBudgetFit): string {
  if (fit.stopped) return `skipped ${step} — the run was asked to stop`;
  return `skipped ${step} — needs ~${minutes(fit.neededMs)}m, ${Math.max(0, Math.floor(fit.leftMs / MINUTE_MS))}m left in the run budget`;
}

export function timeBudgetParkMessage(step: TimeBudgetStep, fit: TimeBudgetFit, summary: CheckSummary): string {
  const failures = summary.results
    .filter((r) => r.result === 'FAIL')
    .map((r) => `${r.checker}: ${r.details.slice(0, MAX_FAILURE_DETAIL)}`);
  return (
    `time budget: ${describeTimeBudgetSkip(step, fit)}; parking with the real check failure` +
    (failures.length > 0 ? `\n${failures.join('\n')}` : '')
  );
}
