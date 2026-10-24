// src/utils/lane-branch-aside.ts — move a lane branch name that survived `git branch -D` out of the way (#3651)

import type { EventKind } from '../events/kinds.js';
import type { PrLookup } from '../phases/ship.js';
import { execGit } from './git-exec.js';

type Log = (type: EventKind, msg: string) => void;

function gitStderr(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  return String(e?.stderr || e?.message || err).trim();
}

/** `<branch>.bak-YYYYMMDD` (UTC), or the first free `-2`, `-3`, ... variant when that name is taken. */
export function bakBranchName(branch: string, now: Date, taken: (name: string) => boolean): string {
  const base = `${branch}.bak-${now.toISOString().slice(0, 10).replace(/-/g, '')}`;
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

async function takenRefNames(repoRoot: string): Promise<Set<string>> {
  const { stdout } = await execGit(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads/', 'refs/remotes/origin/'],
    { cwd: repoRoot },
  );
  return new Set(
    stdout
      .split('\n')
      .map((l) => l.trim().replace(/^origin\//, ''))
      .filter(Boolean),
  );
}

/**
 * Renames the local lane branch to a dated `.bak` name. Origin is moved too, but only when
 * origin/<branch> exists and no open PR owns it (deleting an open PR's head ref would close it).
 */
export async function moveLaneBranchAside(
  repoRoot: string,
  branch: string,
  opts: {
    remoteSha: string | null;
    prStatus: PrLookup['status'] | null;
    now?: () => Date;
    log: Log;
  },
): Promise<{ bak: string; remoteMoved: boolean }> {
  const taken = await takenRefNames(repoRoot);
  const bak = bakBranchName(branch, (opts.now ?? (() => new Date()))(), (n) => taken.has(n));
  try {
    await execGit(['branch', '-m', branch, bak], { cwd: repoRoot });
  } catch (err) {
    throw new Error(
      `setupWorktree: lane branch ${branch} survived 'git branch -D' and could not be renamed to ${bak}: ${gitStderr(err)}`,
      { cause: err },
    );
  }
  let remoteMoved = false;
  if (opts.remoteSha && opts.prStatus === 'absent') {
    try {
      await execGit(['push', 'origin', `${opts.remoteSha}:refs/heads/${bak}`], { cwd: repoRoot });
      await execGit(
        ['push', `--force-with-lease=refs/heads/${branch}:${opts.remoteSha}`, 'origin', `:refs/heads/${branch}`],
        { cwd: repoRoot },
      );
      remoteMoved = true;
    } catch (err) {
      opts.log('warn', `could not move origin/${branch} aside: ${gitStderr(err)}`);
    }
  }
  opts.log(
    'warn',
    opts.prStatus === 'found'
      ? `open PR continues on origin/${branch}; stale local branch ${branch} renamed aside to ${bak}`
      : `lane branch ${branch} already existed and is not owned by an open PR — renamed aside to ${bak}${remoteMoved ? ' (local and origin)' : ' (local only)'}`,
  );
  return { bak, remoteMoved };
}
