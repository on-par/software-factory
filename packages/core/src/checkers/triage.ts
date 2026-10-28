import type { CheckerOutput, CheckSummary } from '../types/index.js';

export type InfraKind = 'timeout' | 'network' | 'missing-tool' | 'evidence-env';
export type CheckFailureTriage = { class: 'code' } | { class: 'infra'; kind: InfraKind; line: string };

// ECONNREFUSED and EPIPE are excluded on purpose: a refused local port is often the lane's own app failing to start.
const NETWORK_PATTERNS: RegExp[] = [
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bEAI_AGAIN\b/,
  /\bENOTFOUND\b/,
  /socket hang up/i,
  /\bERR_PNPM_META_FETCH_FAIL\b/,
  /\bERR_PNPM_FETCH_\d{3}\b/,
  /npm (ERR!|error) network/,
];
const MISSING_TOOL_PATTERN = /command not found/;
const MAX_LINE = 300;

/** Classify one checker result as infrastructure or code (#3371). `Cannot find module` stays code: it is an undeclared dependency.
 * An evidence_plan FAIL whose every failed entry failed identically on base and head is an environment fault (#3749). */
export function triageCheckFailure(result: CheckerOutput): CheckFailureTriage {
  if (result.result !== 'FAIL') return { class: 'code' };
  if (result.checker === 'evidence_plan') {
    const failed = (result.evidencePlanResults ?? []).filter((e) => e.status === 'FAIL');
    if (failed.length > 0 && failed.every((e) => e.sharedFailure !== undefined))
      return { class: 'infra', kind: 'evidence-env', line: failed[0]!.sharedFailure!.slice(0, MAX_LINE) };
  }
  const lines = (result.details ?? '').split('\n');
  if (result.timedOut === true) {
    const first = lines.map((l) => l.trim()).find((l) => l !== '');
    return { class: 'infra', kind: 'timeout', line: (first ?? 'timed out').slice(0, MAX_LINE) };
  }
  const network = lines.find((l) => NETWORK_PATTERNS.some((p) => p.test(l)));
  if (network !== undefined) return { class: 'infra', kind: 'network', line: network.trim().slice(0, MAX_LINE) };
  const missing = lines.find((l) => MISSING_TOOL_PATTERN.test(l));
  if (missing !== undefined) return { class: 'infra', kind: 'missing-tool', line: missing.trim().slice(0, MAX_LINE) };
  return { class: 'code' };
}

export function triageLaneFailures(summary: CheckSummary): Array<{ checker: string; triage: CheckFailureTriage }> {
  return summary.results
    .filter((r) => r.result === 'FAIL')
    .map((r) => ({ checker: r.checker, triage: triageCheckFailure(r) }));
}

export function checkInfraParkMessage(checker: string, line: string): string {
  return `check-infra: ${checker} failed for infrastructure twice (one free re-run, no rework): ${line}`;
}
