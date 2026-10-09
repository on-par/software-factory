import { execFile } from 'node:child_process';
import { join } from 'node:path';

import { defaultRemoteBase, readIssueRunState } from '@on-par/factory-core/internal';

/** One changed file. `added`/`deleted` are null for binary files. */
export interface RunDiffstatFileJson {
  path: string;
  added: number | null;
  deleted: number | null;
}

export interface RunDiffstatTotalsJson {
  files: number;
  added: number;
  deleted: number;
}

export type RunDiffstatReason = 'branch-missing' | 'base-missing' | 'no-branch';

/**
 * Machine-readable output of `factory runs --json --diffstat <issue>`.
 * Additive changes only; bump schemaVersion on a breaking change.
 * `files`/`totals` are null (with a `reason`) when the diff cannot be computed.
 */
export interface RunDiffstatJson {
  schemaVersion: 1;
  issue: number;
  branch: string | null;
  base: string;
  files: RunDiffstatFileJson[] | null;
  totals: RunDiffstatTotalsJson | null;
  reason: RunDiffstatReason | null;
}

/** Runs `git <args>` in cwd without a shell. Resolves stdout; rejects on nonzero exit. */
export type DiffstatGit = (args: readonly string[], cwd: string) => Promise<string>;

/** Thrown when the issue has no readable run state. cmdRuns maps it to exit 1. */
export class NoRunError extends Error {}

const defaultGit: DiffstatGit = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr).trim();
          reject(new Error(detail ? `${error.message}: ${detail}` : error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });

/** Parse the `--diffstat <issue>` value: a positive integer, else throw. */
export function parseDiffstatIssue(raw: string): number {
  const n = /^\d+$/.test(raw) ? Number(raw) : 0;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`invalid --diffstat '${raw}' — expected a positive issue number`);
  }
  return n;
}

/** Parse `git diff --numstat -z --no-renames` output into file rows, in git's order. */
export function parseNumstat(raw: string): RunDiffstatFileJson[] {
  const files: RunDiffstatFileJson[] = [];
  for (const token of raw.split('\0')) {
    if (token === '') continue;
    const first = token.indexOf('\t');
    const second = first === -1 ? -1 : token.indexOf('\t', first + 1);
    if (second === -1) continue;
    const count = (s: string): number | null => (s === '-' ? null : Number(s));
    files.push({
      path: token.slice(second + 1),
      added: count(token.slice(0, first)),
      deleted: count(token.slice(first + 1, second)),
    });
  }
  return files;
}

export async function buildRunDiffstatJson(opts: {
  runsDir: string;
  repoRoot: string;
  issue: number;
  git?: DiffstatGit;
  resolveBase?: (repoRoot: string) => Promise<string>;
}): Promise<RunDiffstatJson> {
  const { runsDir, repoRoot, issue, git = defaultGit, resolveBase = defaultRemoteBase } = opts;
  const state = await readIssueRunState(join(runsDir, `issue-${issue}.json`));
  if (state === null) throw new NoRunError(`no run for issue #${issue}`);
  const base = await resolveBase(repoRoot);
  const branch = typeof state.branch === 'string' && state.branch !== '' ? state.branch : null;
  const unavailable = (reason: RunDiffstatReason): RunDiffstatJson => ({
    schemaVersion: 1,
    issue,
    branch,
    base,
    files: null,
    totals: null,
    reason,
  });
  if (branch === null) return unavailable('no-branch');

  const resolves = async (ref: string): Promise<boolean> => {
    try {
      await git(['rev-parse', '--verify', '-q', `${ref}^{commit}`], repoRoot);
      return true;
    } catch {
      return false;
    }
  };
  if (!(await resolves(base))) return unavailable('base-missing');

  let ref: string | null = null;
  for (const candidate of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    if (await resolves(candidate)) {
      ref = candidate;
      break;
    }
  }
  if (ref === null) return unavailable('branch-missing');

  const raw = await git(['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', `${base}...${ref}`], repoRoot);
  const files = parseNumstat(raw);
  const totals: RunDiffstatTotalsJson = { files: files.length, added: 0, deleted: 0 };
  for (const f of files) {
    totals.added += f.added ?? 0;
    totals.deleted += f.deleted ?? 0;
  }
  return { schemaVersion: 1, issue, branch, base, files, totals, reason: null };
}
