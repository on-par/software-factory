import type { Octokit } from '@octokit/rest';

import { upsertMarkedBlock } from '../review/marked-block.js';
import { previewTimings, type PreviewCheckResult } from './preview-evidence.js';

export const PREVIEW_RECEIPT_START = '<!-- factory:preview-receipt v1 -->';
export const PREVIEW_RECEIPT_END = '<!-- /factory:preview-receipt -->';

export function renderPreviewReceipt(result: PreviewCheckResult): string {
  const e = result.evidence;
  return [
    PREVIEW_RECEIPT_START,
    '### Preview check',
    '',
    `**Result: ${result.status}** on \`${e.url ?? '-'}\` at \`${e.headSha.slice(0, 12)}\``,
    '',
    ...(e.command.length > 0 ? [`- Command: \`${e.command.join(' ')}\``] : []),
    `- ${previewTimings(e)}`,
    ...(e.exitCode === undefined ? [] : [`- Exit code: ${e.exitCode}`]),
    ...(e.reason ? [`- Reason: ${e.reason}`] : []),
    ...(e.artifacts.length > 0
      ? [`- Artifacts: ${e.artifacts.join(', ')}${e.artifactsDir ? ' (copied to the run logs)' : ''}`]
      : []),
    '',
    "_Run by the factory against the PR's preview after CI. Regenerated on each SHIP._",
    PREVIEW_RECEIPT_END,
  ].join('\n');
}

export async function publishPreviewReceipt(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  result: PreviewCheckResult,
): Promise<void> {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const markers = { start: PREVIEW_RECEIPT_START, end: PREVIEW_RECEIPT_END };
  const body = upsertMarkedBlock(data.body, renderPreviewReceipt(result), markers);
  if (body === (data.body ?? '')) return;
  await octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, body });
}
