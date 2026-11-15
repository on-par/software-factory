import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';

import type { VisualProofMode } from '../config/visual-proof-section.js';
import { upsertMarkedBlock } from '../review/marked-block.js';
import { describeVisualProofStep, type VisualProofImage, type VisualProofResult } from './visual-proof.js';

export const VISUAL_PROOF_STATUS_CONTEXT = 'factory/visual-proof';
export const VISUAL_PROOF_START = '<!-- factory:visual-proof v1 required -->';
export const VISUAL_PROOF_ADVISORY_START = '<!-- factory:visual-proof v1 advisory -->';
export const VISUAL_PROOF_END = '<!-- /factory:visual-proof -->';
export const DEFAULT_EVIDENCE_BRANCH = 'factory-evidence';

const STATUS_DESCRIPTION_MAX = 140;
const DIAGNOSTIC_MAX = 500;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const httpStatus = (err: unknown): number | undefined =>
  typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number' ? err.status : undefined;

const head12 = (sha: string): string => sha.slice(0, 12);

const slug = (text: string): string => text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'root';

const fail = (result: VisualProofResult, diagnostic: string): VisualProofResult => {
  return { status: 'fail', headSha: result.headSha, runId: result.runId, captures: result.captures, diagnostic };
};

interface UploadTarget {
  owner: string;
  repo: string;
  prNumber: number;
  branch: string;
  evidenceBranch?: string;
}

export async function attachVisualProof(
  octokit: Octokit,
  target: UploadTarget,
  result: VisualProofResult,
  readFile: (path: string) => Buffer = readFileSync,
): Promise<VisualProofResult> {
  const { owner, repo, prNumber, branch } = target;
  const evidenceBranch = target.evidenceBranch ?? DEFAULT_EVIDENCE_BRANCH;
  if (evidenceBranch === branch) {
    return fail(
      result,
      `refusing to write visual proof to the PR branch ${branch}; set visualProof.evidenceBranch to a branch other than the PR head branch`,
    );
  }
  if (evidenceBranch.startsWith('factory/')) {
    return fail(
      result,
      `refusing to write visual proof to the reserved branch ${evidenceBranch}; set visualProof.evidenceBranch to a branch outside factory/`,
    );
  }
  if (!result.outDir) return fail(result, 'upload failed: capture output directory unknown');
  const outDir = result.outDir;
  const git = octokit.rest.git;
  const dir = `visual-proof/${prNumber}/${slug(result.runId)}/${head12(result.headSha)}`;

  let commitSha: string;
  const placed: { after: string; before?: string; clip?: string; clipFormat?: 'gif' | 'webm' | 'mp4' }[] = [];
  try {
    const blobs: { path: string; sha: string; size: number }[] = [];
    const upload = async (file: string, name: string): Promise<string> => {
      const bytes = readFile(join(outDir, file));
      const { data } = await git.createBlob({ owner, repo, content: bytes.toString('base64'), encoding: 'base64' });
      const path = `${dir}/${name}`;
      blobs.push({ path, sha: data.sha, size: bytes.length });
      return path;
    };
    for (const [i, c] of result.captures.entries()) {
      const stem = `${i}-${slug(c.route)}-${slug(c.state)}`;
      const size = `${c.viewport.width}x${c.viewport.height}`;
      const after = await upload(c.file, `${stem}-${size}.png`);
      const before = c.before ? await upload(c.before.file, `${stem}-before-${size}.png`) : undefined;
      const clip = c.clip ? await upload(c.clip.file, `${stem}-clip.${c.clip.format}`) : undefined;
      placed.push({ after, ...(before ? { before } : {}), ...(clip ? { clip, clipFormat: c.clip?.format } : {}) });
    }
    let written: string | undefined;
    for (let attempt = 1; written === undefined; attempt++) {
      let parent: string | undefined;
      try {
        parent = (await git.getRef({ owner, repo, ref: `heads/${evidenceBranch}` })).data.object.sha;
      } catch (err) {
        if (httpStatus(err) !== 404) throw err;
      }
      const baseTree = parent ? (await git.getCommit({ owner, repo, commit_sha: parent })).data.tree.sha : undefined;
      const { data: tree } = await git.createTree({
        owner,
        repo,
        ...(baseTree ? { base_tree: baseTree } : {}),
        tree: blobs.map((b) => ({ path: b.path, mode: '100644' as const, type: 'blob' as const, sha: b.sha })),
      });
      const { data: commit } = await git.createCommit({
        owner,
        repo,
        message: `visual proof for PR #${prNumber} at ${head12(result.headSha)} (run ${result.runId})`,
        tree: tree.sha,
        parents: parent ? [parent] : [],
      });
      try {
        if (parent) await git.updateRef({ owner, repo, ref: `heads/${evidenceBranch}`, sha: commit.sha, force: false });
        else await git.createRef({ owner, repo, ref: `refs/heads/${evidenceBranch}`, sha: commit.sha });
        written = commit.sha;
      } catch (err) {
        if (httpStatus(err) !== 422 || attempt >= 2) throw err;
      }
    }
    commitSha = written;
    const sizes = new Map(blobs.map((b) => [b.path, b.size]));
    for (const { path } of blobs) {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref: commitSha });
      if (Array.isArray(data) || data.type !== 'file' || data.size !== sizes.get(path)) {
        return fail(result, `embedded asset unavailable: ${path} did not read back from ${commitSha.slice(0, 12)}`);
      }
    }
  } catch (err) {
    const diagnostic = errorMessage(err).slice(0, DIAGNOSTIC_MAX);
    return fail(result, `upload failed: ${diagnostic}`);
  }
  const urlFor = (path: string): string => `https://github.com/${owner}/${repo}/blob/${commitSha}/${path}?raw=true`;
  const images: VisualProofImage[] = result.captures.map((c, i) => {
    const at = placed[i];
    return {
      route: c.route,
      state: c.state,
      viewport: c.viewport,
      url: urlFor(at?.after ?? ''),
      ...(at?.before ? { beforeUrl: urlFor(at.before) } : {}),
      ...(at?.clip ? { clipUrl: urlFor(at.clip), clipFormat: at.clipFormat } : {}),
      ...(c.steps ? { steps: c.steps } : {}),
    };
  });
  return { ...result, status: 'pass', images };
}

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
    if (image.clipUrl) {
      lines.push(
        image.clipFormat === 'gif' ? `![clip](${image.clipUrl})` : `[▶ clip (${image.clipFormat})](${image.clipUrl})`,
        '',
      );
    }
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
