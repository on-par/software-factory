// packages/core/src/run/stack-rebase.ts — shared rebase --onto + atomic leased push for stacked branches (ADR-0161).

import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { execGit } from '../utils/git-exec.js';

export interface StackRebaseLayer {
  branch: string;
  /** The branch head the factory recorded; the push lease and rebase tip. */
  recordedHead: string;
  /** The old base commit: commits after it are replayed. */
  upstream: string;
}

export interface StackRebaseOptions {
  repoRoot: string;
  remote: string;
  /** Ref the first layer is replayed onto. */
  startBase: string;
  layers: StackRebaseLayer[];
}

export type StackRebaseResult =
  | { ok: true; newHeads: string[] }
  | { ok: false; at: number; phase: 'setup' | 'rebase' | 'push'; reason: string; files: string[] };

export function gitErrorDetail(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
  if (stderr) return stderr;
  return err instanceof Error ? err.message : String(err);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execGit(args, { cwd })).stdout.trim();
}

async function succeeds(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await execGit(args, { cwd });
    return true;
  } catch {
    return false;
  }
}

/** Rebases each layer bottom-up with `--onto` in a temp detached worktree, then pushes all in one leased atomic push. */
export async function rebaseAndPushStack(opts: StackRebaseOptions): Promise<StackRebaseResult> {
  const { repoRoot, remote, startBase, layers } = opts;
  // Scratch worktree lives inside the repo's git dir, not the shared OS temp dir.
  const gitDir = resolve(repoRoot, await git(repoRoot, 'rev-parse', '--git-common-dir'));
  const tmp = await mkdtemp(join(gitDir, 'factory-restack-'));
  const newHeads: string[] = [];
  try {
    try {
      await git(repoRoot, 'worktree', 'add', '--detach', tmp, startBase);
    } catch (err) {
      return { ok: false, at: 0, phase: 'setup', reason: gitErrorDetail(err), files: [] };
    }
    for (const [at, layer] of layers.entries()) {
      const newBase = at === 0 ? startBase : newHeads[at - 1]!;
      try {
        await git(tmp, 'checkout', '--detach', layer.recordedHead);
        await git(tmp, 'rebase', '--onto', newBase, layer.upstream);
      } catch (err) {
        let files: string[] = [];
        try {
          files = (await git(tmp, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
        } catch {
          // best effort
        }
        await succeeds(tmp, 'rebase', '--abort');
        const why = files.length > 0 ? `conflicted in: ${files.join(', ')}` : `failed: ${gitErrorDetail(err)}`;
        return { ok: false, at, phase: 'rebase', reason: `onto ${newBase} ${why}; nothing was pushed`, files };
      }
      newHeads.push(await git(tmp, 'rev-parse', 'HEAD'));
    }
    try {
      await git(
        tmp,
        'push',
        '--atomic',
        remote,
        ...layers.map((l) => `--force-with-lease=refs/heads/${l.branch}:${l.recordedHead}`),
        ...layers.map((l, at) => `${newHeads[at]}:refs/heads/${l.branch}`),
      );
    } catch (err) {
      const text = gitErrorDetail(err);
      const at = Math.max(
        0,
        layers.findIndex((l) => text.includes(l.branch)),
      );
      const named = layers[at]!;
      return {
        ok: false,
        at,
        phase: 'push',
        reason: `(${named.branch}) was refused (lease on ${named.recordedHead}): ${text}; nothing was pushed`,
        files: [],
      };
    }
  } finally {
    await succeeds(repoRoot, 'worktree', 'remove', '--force', tmp);
    await rm(tmp, { recursive: true, force: true });
  }
  return { ok: true, newHeads };
}
