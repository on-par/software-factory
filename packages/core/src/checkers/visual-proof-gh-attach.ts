import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';

import { runCommand } from '../utils/command-runner.js';
import { checkGhVersion } from '../utils/gh-version.js';
import { errorMessage } from './preview-wait.js';
import {
  type PublishedVisualProofMode,
  publishVisualProof,
  renderVisualProofBlock,
  stampVisualProofStatus,
  upsertVisualProofBlock,
} from './visual-proof-attach.js';
import type { VisualProofImage, VisualProofResult } from './visual-proof.js';

const BODY_FILE = 'visual-proof-pr-body.md';
const EDIT_TIMEOUT_MS = 300_000;
const SAFE_NAME = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const ref = (file: string): string => `./${file}`;

function unsafeName(result: VisualProofResult): string | undefined {
  const bad = result.captures.find((c) => [c.file, c.before?.file, c.clip?.file].some((f) => f && !SAFE_NAME.test(f)));
  return bad && `unsafe proof file name for ${bad.route} (state ${bad.state}): use only letters, digits, . _ - and /`;
}

function attachArgs(result: VisualProofResult): string[] {
  const short = result.headSha.slice(0, 12);
  const files = new Map<string, string>();
  for (const c of result.captures) {
    const label = `${c.route} ${c.state}`;
    files.set(c.file, `${ref(c.file)}#${label} ${c.before ? 'after ' : ''}at ${short}`);
    if (c.before) files.set(c.before.file, `${ref(c.before.file)}#${label} before`);
    if (c.clip) files.set(c.clip.file, c.clip.format === 'gif' ? `${ref(c.clip.file)}#clip` : ref(c.clip.file));
  }
  return [...files.values()].flatMap((arg) => ['--attach', arg]);
}

const imagesFor = (result: VisualProofResult): VisualProofImage[] =>
  result.captures.map((c) => ({
    route: c.route,
    state: c.state,
    viewport: c.viewport,
    url: ref(c.file),
    ...(c.before ? { beforeUrl: ref(c.before.file) } : {}),
    ...(c.clip ? { clipUrl: ref(c.clip.file), clipFormat: c.clip.format } : {}),
    ...(c.steps ? { steps: c.steps } : {}),
  }));

export async function publishVisualProofWithGh(
  octokit: Octokit,
  target: { owner: string; repo: string; prNumber: number },
  result: VisualProofResult,
  mode: PublishedVisualProofMode = 'required',
  run: typeof runCommand = runCommand,
): Promise<VisualProofResult> {
  const failWith = async (diagnostic: string): Promise<VisualProofResult> => {
    const { headSha, runId, captures } = result;
    const failed: VisualProofResult = { status: 'fail', headSha, runId, captures, diagnostic };
    await publishVisualProof(octokit, target, failed, mode);
    return failed;
  };
  if (result.status !== 'pass') {
    await publishVisualProof(octokit, target, result, mode);
    return result;
  }
  if (!result.outDir) return failWith('attach failed: capture output directory unknown');
  const preflight = unsafeName(result) ?? (await checkGhVersion(run));
  if (preflight) return failWith(preflight);
  const { owner, repo, prNumber } = target;
  const proof = { ...result, images: imagesFor(result) };
  const bodyFile = join(result.outDir, BODY_FILE);
  try {
    const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    writeFileSync(bodyFile, upsertVisualProofBlock(data.body, renderVisualProofBlock(proof, mode), mode));
  } catch (err) {
    return failWith(`attach failed: could not write the PR body: ${errorMessage(err)}`);
  }
  const edit = ['gh', 'pr', 'edit', String(prNumber), '--repo', `${owner}/${repo}`, '--body-file', bodyFile];
  const r = await run([...edit, ...attachArgs(result)], { cwd: result.outDir, timeoutMs: EDIT_TIMEOUT_MS });
  if (!r.ok) return failWith(`gh pr edit --attach failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
  await stampVisualProofStatus(octokit, target, proof, mode);
  return proof;
}
