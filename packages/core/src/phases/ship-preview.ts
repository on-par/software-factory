import { writePreviewEvidence, type PreviewCheckResult } from '../checkers/preview-evidence.js';
import { maskUrl } from '../checkers/preview-url-guard.js';
import type { EventKind } from '../events/kinds.js';

export type PreviewGate = (pr: { prNumber: number; headSha: string }) => Promise<PreviewCheckResult>;

export interface PreviewGateContext {
  log: (type: EventKind, msg: string) => void;
  ciPending: boolean;
  logsDir?: string;
  publish?: (prNumber: number, result: PreviewCheckResult) => Promise<void>;
}

const CI_PENDING_REASON = 'CI pending, preview not checked';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const unavailable = (headSha: string, reason: string): PreviewCheckResult => ({
  status: 'preview-unavailable',
  evidence: { headSha, command: [], readyWaitMs: 0, durationMs: 0, artifacts: [], reason },
});

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

async function gateResult(
  gate: PreviewGate,
  pr: { prNumber: number; headSha: string },
  ctx: PreviewGateContext,
): Promise<PreviewCheckResult> {
  if (ctx.ciPending) return writePreviewEvidence(unavailable(pr.headSha, CI_PENDING_REASON), ctx.logsDir);
  try {
    return await gate(pr);
  } catch (err) {
    return writePreviewEvidence(unavailable(pr.headSha, errorMessage(err)), ctx.logsDir);
  }
}

export async function runPreviewGate(
  gate: PreviewGate,
  pr: { prNumber: number; headSha: string },
  ctx: PreviewGateContext,
): Promise<PreviewCheckResult> {
  const result = await gateResult(gate, pr, ctx);
  const { status, evidence } = result;
  const timings = `ready wait ${seconds(evidence.readyWaitMs)}${evidence.commandMs === undefined ? '' : `, command ${seconds(evidence.commandMs)}`}`;
  ctx.log(
    'ship',
    `preview check ${status} for PR #${pr.prNumber} on ${evidence.url ? maskUrl(evidence.url) : '-'} (${pr.headSha.slice(0, 12)}; ${timings})` +
      (evidence.evidencePath ? ` — ${evidence.evidencePath}` : ''),
  );
  try {
    await ctx.publish?.(pr.prNumber, result);
  } catch (err) {
    ctx.log('warn', `could not write the preview result to PR #${pr.prNumber}: ${errorMessage(err)}`);
  }
  return result;
}

export function previewFailureReason(prNumber: number, result: PreviewCheckResult): string {
  const detail = result.evidence.reason ?? `exit code ${result.evidence.exitCode ?? 'unknown'}`;
  return `preview check ${result.status} for PR #${prNumber}: ${detail}`;
}
