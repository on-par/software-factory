import type { Octokit } from '@octokit/rest';

import type { VisualProofMode } from '../config/visual-proof-section.js';
import { upsertMarkedBlock } from '../review/marked-block.js';
import { describeVisualProofStep } from './visual-proof-manifest.js';
import type { VisualProofResult } from './visual-proof.js';

export const VISUAL_PROOF_STATUS_CONTEXT = 'factory/visual-proof';
export const VISUAL_PROOF_START = '<!-- factory:visual-proof v1 required -->';
export const VISUAL_PROOF_ADVISORY_START = '<!-- factory:visual-proof v1 advisory -->';
export const VISUAL_PROOF_END = '<!-- /factory:visual-proof -->';

const STATUS_DESCRIPTION_MAX = 140;
const DIAGNOSTIC_MAX = 500;

const head12 = (sha: string): string => sha.slice(0, 12);

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, DIAGNOSTIC_MAX);

export type PublishedVisualProofMode = Exclude<VisualProofMode, 'off'>;

const startMarker = (mode: PublishedVisualProofMode): string =>
  mode === 'advisory' ? VISUAL_PROOF_ADVISORY_START : VISUAL_PROOF_START;

export function renderVisualProofBlock(result: VisualProofResult, mode: PublishedVisualProofMode = 'required'): string {
  const short = head12(result.headSha);
  const advisory = mode === 'advisory';
  const lines = [
    startMarker(mode),
    '### Visual proof',
    '',
    `**Result: ${result.status}**${advisory ? ' (advisory)' : ''} · run \`${result.runId}\` · head \`${short}\``,
    '',
  ];
  for (const image of result.images ?? []) {
    lines.push(
      `- \`${image.route}\` · state \`${image.state}\` · ${image.viewport.width}x${image.viewport.height}`,
      '',
    );
    if (image.beforeUrl) {
      lines.push(
        '| Before | After |',
        '| --- | --- |',
        `| ![${image.route} ${image.state} before](${image.beforeUrl}) | ![${image.route} ${image.state} after at ${short}](${image.url}) |`,
        '',
      );
    } else {
      lines.push(`![${image.route} ${image.state} at ${short}](${image.url})`, '');
    }
    if (image.steps?.length) {
      lines.push(`Steps: ${image.steps.map((st, n) => `${n + 1}. ${describeVisualProofStep(st)}`).join(' · ')}`, '');
    }
    if (image.clipUrl) lines.push(`![clip](${image.clipUrl})`, '');
  }
  if (result.uncovered?.length) {
    lines.push(`- Coverage warning: UI files not covered by any visualProof route: ${result.uncovered.join(', ')}`, '');
  }
  if (result.status !== 'pass') {
    lines.push(`**Visual proof unavailable: ${oneLine(result.diagnostic ?? result.status)}**`, '');
    if (advisory) {
      lines.push('- Advisory: `visualProof.mode` is `advisory`, so this result does not block SHIP or merge');
    }
    lines.push(
      `- Diagnostic: ${oneLine(result.diagnostic ?? 'no diagnostic recorded')}`,
      `- Remedy: fix the cause above, then re-run SHIP (\`factory resume --from ship\`) to capture proof for ${short}`,
      '',
    );
  }
  lines.push(VISUAL_PROOF_END);
  return lines.join('\n');
}

export async function publishVisualProof(
  octokit: Octokit,
  target: { owner: string; repo: string; prNumber: number },
  result: VisualProofResult,
  mode: PublishedVisualProofMode = 'required',
): Promise<void> {
  const { owner, repo, prNumber } = target;
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const body = upsertVisualProofBlock(data.body, renderVisualProofBlock(result, mode), mode);
  if (body !== (data.body ?? '')) await octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, body });
  await stampVisualProofStatus(octokit, target, result, mode);
}

export async function stampVisualProofStatus(
  octokit: Octokit,
  target: { owner: string; repo: string },
  result: VisualProofResult,
  mode: PublishedVisualProofMode,
): Promise<void> {
  const { owner, repo } = target;
  const pass = result.status === 'pass';
  const diagnostic = oneLine(result.diagnostic ?? `visual proof ${result.status}`);
  const state = pass || mode === 'advisory' ? 'success' : 'failure';
  const description = pass
    ? `visual proof captured for ${head12(result.headSha)}`
    : mode === 'advisory'
      ? `advisory: visual proof ${result.status}: ${diagnostic}`
      : diagnostic;
  await octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: result.headSha,
    context: VISUAL_PROOF_STATUS_CONTEXT,
    state,
    description: description.slice(0, STATUS_DESCRIPTION_MAX),
  });
}

export function upsertVisualProofBlock(
  body: string | null | undefined,
  block: string,
  mode: PublishedVisualProofMode,
): string {
  const start = startMarker(mode);
  const other = mode === 'advisory' ? VISUAL_PROOF_START : VISUAL_PROOF_ADVISORY_START;
  const swapped = body?.includes(other)
    ? upsertMarkedBlock(body, block, { start: other, end: VISUAL_PROOF_END })
    : body;
  return upsertMarkedBlock(swapped, block, { start, end: VISUAL_PROOF_END });
}

export class VisualProofMissingError extends Error {
  constructor(
    message: string,
    readonly prNumber: number,
  ) {
    super(message);
    this.name = 'VisualProofMissingError';
  }
}

export async function assertVisualProofForHead(
  octokit: Octokit,
  target: { owner: string; repo: string; prNumber: number; prBody: string | null; headSha: string },
  selfId: () => Promise<number>,
): Promise<void> {
  if (!target.prBody?.includes(VISUAL_PROOF_START)) return;
  const { owner, repo, prNumber, headSha } = target;
  const { data } = await octokit.rest.repos.listCommitStatusesForRef({ owner, repo, ref: headSha, per_page: 100 });
  const latest = data.find((s) => s.context === VISUAL_PROOF_STATUS_CONTEXT);
  if (latest?.state === 'success' && latest.creator?.id === (await selfId())) return;
  const seen = latest ? `latest status is ${latest.state}` : 'no factory/visual-proof status';
  throw new VisualProofMissingError(
    `PR #${prNumber} requires UI visual proof but head ${head12(headSha)} has no factory-created success status (${seen}) — re-run SHIP (factory resume --from ship) to capture proof for ${head12(headSha)}`,
    prNumber,
  );
}
