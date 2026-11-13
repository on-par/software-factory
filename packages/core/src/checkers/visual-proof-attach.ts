// src/checkers/visual-proof-attach.ts — uploads proof images to the evidence branch, embeds them in the PR body and stamps the per-head status (#2232)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';

import { upsertMarkedBlock } from '../review/marked-block.js';
import type { VisualProofResult } from './visual-proof.js';

export const VISUAL_PROOF_STATUS_CONTEXT = 'factory/visual-proof';
export const VISUAL_PROOF_START = '<!-- factory:visual-proof v1 required -->';
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
  /** The PR head branch: never written. */
  branch: string;
  evidenceBranch?: string;
}

/** Commits the captured PNGs to the evidence branch and returns their immutable, read-back-verified URLs. */
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
  let paths: string[];
  try {
    const blobs: { path: string; sha: string; size: number }[] = [];
    for (const [i, c] of result.captures.entries()) {
      const bytes = readFile(join(outDir, c.file));
      const { data } = await git.createBlob({ owner, repo, content: bytes.toString('base64'), encoding: 'base64' });
      const name = `${i}-${slug(c.route)}-${slug(c.state)}-${c.viewport.width}x${c.viewport.height}.png`;
      blobs.push({ path: `${dir}/${name}`, sha: data.sha, size: bytes.length });
    }
    paths = blobs.map((b) => b.path);
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
    for (const path of paths) {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref: commitSha });
      if (Array.isArray(data) || data.type !== 'file' || data.size !== sizes.get(path)) {
        return fail(result, `embedded asset unavailable: ${path} did not read back from ${commitSha.slice(0, 12)}`);
      }
    }
  } catch (err) {
    const diagnostic = errorMessage(err).slice(0, DIAGNOSTIC_MAX);
    return fail(result, `upload failed: ${diagnostic}`);
  }
  const images = result.captures.map((c, i) => ({
    route: c.route,
    state: c.state,
    viewport: c.viewport,
    url: `https://github.com/${owner}/${repo}/blob/${commitSha}/${paths[i]}?raw=true`,
  }));
  return { ...result, status: 'pass', images };
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, DIAGNOSTIC_MAX);

export function renderVisualProofBlock(result: VisualProofResult): string {
  const short = head12(result.headSha);
  const lines = [
    VISUAL_PROOF_START,
    '### Visual proof',
    '',
    `**Result: ${result.status}** · run \`${result.runId}\` · head \`${short}\``,
    '',
  ];
  for (const image of result.images ?? []) {
    lines.push(
      `- \`${image.route}\` · state \`${image.state}\` · ${image.viewport.width}x${image.viewport.height}`,
      '',
      `![${image.route} ${image.state} at ${short}](${image.url})`,
      '',
    );
  }
  if (result.status !== 'pass') {
    lines.push(
      `- Diagnostic: ${oneLine(result.diagnostic ?? 'no diagnostic recorded')}`,
      `- Remedy: fix the cause above, then re-run SHIP (\`factory resume --from ship\`) to capture proof for ${short}`,
      '',
    );
  }
  lines.push(VISUAL_PROOF_END);
  return lines.join('\n');
}

/** Upserts the proof block into the PR body, then stamps the per-head commit status. */
export async function publishVisualProof(
  octokit: Octokit,
  target: { owner: string; repo: string; prNumber: number },
  result: VisualProofResult,
): Promise<void> {
  const { owner, repo, prNumber } = target;
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const body = upsertMarkedBlock(data.body, renderVisualProofBlock(result), {
    start: VISUAL_PROOF_START,
    end: VISUAL_PROOF_END,
  });
  if (body !== (data.body ?? '')) await octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, body });
  const pass = result.status === 'pass';
  await octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: result.headSha,
    context: VISUAL_PROOF_STATUS_CONTEXT,
    state: pass ? 'success' : 'failure',
    description: (pass
      ? `visual proof captured for ${head12(result.headSha)}`
      : oneLine(result.diagnostic ?? `visual proof ${result.status}`)
    ).slice(0, STATUS_DESCRIPTION_MAX),
  });
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

/** Throws unless a marked PR's exact head carries a factory-created `factory/visual-proof` success status. */
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
