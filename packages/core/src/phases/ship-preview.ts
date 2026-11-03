// src/phases/ship-preview.ts — runs SHIP's opt-in preview gate and fails closed when the gate itself throws (#3880)

import type { PreviewCheckResult } from '../checkers/preview-check.js';
import type { EventKind } from '../events/kinds.js';

export type PreviewGate = (pr: { prNumber: number; headSha: string }) => Promise<PreviewCheckResult>;

/** Runs the gate and logs its verdict; a throwing gate becomes `preview-unavailable`. */
export async function runPreviewGate(
  gate: PreviewGate,
  pr: { prNumber: number; headSha: string },
  log: (type: EventKind, msg: string) => void,
): Promise<PreviewCheckResult> {
  let result: PreviewCheckResult;
  try {
    result = await gate(pr);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    result = {
      status: 'preview-unavailable',
      evidence: { headSha: pr.headSha, command: [], durationMs: 0, artifacts: [], reason },
    };
  }
  const { status, evidence } = result;
  log(
    'ship',
    `preview check ${status} for PR #${pr.prNumber} on ${evidence.url ?? '-'} (${pr.headSha.slice(0, 12)})` +
      (evidence.evidencePath ? ` — ${evidence.evidencePath}` : ''),
  );
  return result;
}

export function previewFailureReason(prNumber: number, result: PreviewCheckResult): string {
  const detail = result.evidence.reason ?? `exit code ${result.evidence.exitCode ?? 'unknown'}`;
  return `preview check ${result.status} for PR #${prNumber}: ${detail}`;
}
