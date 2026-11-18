import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { Octokit } from '@octokit/rest';
import { workKeyFromIssue } from '@on-par/factory-core';
import { readHandoffComment, type RemainingWorkHandoff } from '@on-par/factory-core/internal';

import { CliExitError } from './errors.js';
import { handoffJsonSchema } from './handoff-contract.js';
import { parseBaseBranch, type ContinueFrom } from './ship-options.js';

type Git = (args: readonly string[]) => Promise<string>;

const run = promisify(execFile);

function exit(message: string): CliExitError {
  return new CliExitError(`factory: ${message} — nothing was changed`, 2);
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function continueFromConflict(opts: {
  continueFrom?: string;
  handoff?: string;
  stack: boolean;
  inPlace: boolean;
}): string | undefined {
  if (opts.continueFrom === undefined) {
    return opts.handoff === undefined ? undefined : 'factory: --handoff needs --continue-from <branch>';
  }
  if (parseBaseBranch(opts.continueFrom) === undefined) {
    return `factory: invalid --continue-from '${opts.continueFrom}' — expected a branch name (not empty, not starting with '-')`;
  }
  if (opts.stack) return 'factory: --continue-from continues one branch — drop --stack or drop --continue-from';
  if (opts.inPlace) return 'factory: --continue-from builds a new worktree — drop --in-place or drop --continue-from';
  return undefined;
}

export function continuedBranchFor(branch: string, headSha: string): string {
  return `${branch}-cont-${headSha.slice(0, 7)}`;
}

async function readHandoff(opts: {
  file?: string;
  octokit: Octokit;
  repo: string;
  issue: number;
}): Promise<{ raw: unknown; source: string }> {
  if (opts.file !== undefined) {
    try {
      return { raw: JSON.parse(await readFile(opts.file, 'utf-8')), source: opts.file };
    } catch (err) {
      throw exit(`could not read --handoff ${opts.file}: ${why(err)}`);
    }
  }
  const source = `the handoff comment on #${opts.issue}`;
  let raw: unknown;
  try {
    raw = await readHandoffComment({ octokit: opts.octokit, repo: opts.repo, issue: workKeyFromIssue(opts.issue) });
  } catch (err) {
    throw exit(`could not read ${source}: ${why(err)}`);
  }
  if (raw === undefined) throw exit(`no handoff comment found on #${opts.issue}; pass --handoff <file>`);
  return { raw, source };
}

export async function resolveContinueFrom(opts: {
  branch: string;
  handoffFile?: string;
  octokit: Octokit;
  repo: string;
  issue: number;
  repoRoot: string;
  git?: Git;
}): Promise<ContinueFrom> {
  const git: Git = opts.git ?? (async (args) => (await run('git', [...args], { cwd: opts.repoRoot })).stdout);
  const { raw, source } = await readHandoff({ ...opts, file: opts.handoffFile });
  const wrapped = typeof raw === 'object' && raw !== null && 'handoff' in raw ? raw.handoff : raw;
  const parsed = handoffJsonSchema.safeParse(wrapped);
  if (!parsed.success)
    throw exit(`invalid handoff in ${source}: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);
  const handoff: RemainingWorkHandoff = parsed.data;
  const { branch } = opts;
  await git(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]).catch(() => '');
  const resolveRef = (ref: string) => git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]).then((s) => s.trim());
  const headSha = await resolveRef(`refs/remotes/origin/${branch}`)
    .catch(() => resolveRef(`refs/heads/${branch}`))
    .catch(() => '');
  if (headSha === '') throw exit(`--continue-from branch ${branch} was not found on origin or locally`);
  if (handoff.headSha !== headSha) {
    throw exit(`${branch} is at ${headSha} but the handoff expects ${handoff.headSha ?? 'no head sha'}`);
  }
  return { branch, headSha, handoff };
}
