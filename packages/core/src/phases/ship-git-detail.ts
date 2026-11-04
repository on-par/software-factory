// packages/core/src/phases/ship-git-detail.ts — command runner type and push-failure description for SHIP

import { shellEscape } from '../utils/index.js';

export type CommandRunner = (
  command: string,
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string }>;

/** Why a `git push` was refused, as far as git's own stderr says (#733). */
export type PushFailureKind = 'non-fast-forward' | 'network' | 'unknown';

/** Bound on the failure text copied into one NDJSON event row. */
const MAX_PUSH_ERROR_DETAIL = 400;

const NON_FAST_FORWARD_MARKERS = [
  'non-fast-forward',
  '! [rejected]',
  'fetch first',
  'updates were rejected',
  'stale info',
];

const NETWORK_MARKERS = [
  'could not resolve host',
  'failed to connect',
  'connection timed out',
  'connection refused',
  'network is unreachable',
  'operation timed out',
  'the remote end hung up unexpectedly',
];

function classifyPushFailure(text: string): PushFailureKind {
  const t = text.toLowerCase();
  if (NON_FAST_FORWARD_MARKERS.some((m) => t.includes(m))) return 'non-fast-forward';
  if (NETWORK_MARKERS.some((m) => t.includes(m))) return 'network';
  return 'unknown';
}

/**
 * The real reason a push failed, from git's own stderr when the runner exposes it
 * (node's promisified `exec` rejection carries `stderr`), else the Error message, else the
 * value's string form. Flattened to one line and bounded so a single event row stays
 * greppable in `.factory/events.ndjson`.
 */
export function describePushFailure(err: unknown): { kind: PushFailureKind; detail: string } {
  const raw = (err as { stderr?: unknown } | null | undefined)?.stderr;
  const stderr = typeof raw === 'string' ? raw : '';
  const text = stderr.trim() || (err instanceof Error ? err.message : String(err));
  const detail = text.replace(/\s+/g, ' ').trim().slice(0, MAX_PUSH_ERROR_DETAIL);
  return { kind: classifyPushFailure(detail), detail: detail || 'no error output' };
}

/** Bound on the ls-remote failure text copied into one NDJSON event row (#735). */
const MAX_REMOTE_HEAD_DETAIL = 200;

/** Prefer stderr, then stdout, before the error fallback; keep details flattened and bounded. */
export function shortDetail(err: unknown): string {
  const output = err as { stderr?: unknown; stdout?: unknown } | null | undefined;
  const rawStderr = output?.stderr;
  const rawStdout = output?.stdout;
  const stderr = typeof rawStderr === 'string' ? rawStderr.trim() : '';
  const stdout = typeof rawStdout === 'string' ? rawStdout.trim() : '';
  const text = stderr || stdout || (err instanceof Error ? err.message : String(err));
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_REMOTE_HEAD_DETAIL) || 'no error output';
}

/** Whether origin's head is an ancestor of local HEAD, i.e. a plain push is a fast-forward (#1815). */
export type RemoteAncestry = { status: 'ancestor' } | { status: 'diverged' } | { status: 'unreadable'; detail: string };

const MISSING_OBJECT_MARKERS = ['not a valid object name', 'not a valid commit', 'bad object', 'unknown revision'];

export async function checkRemoteIsAncestor(
  run: CommandRunner,
  worktree: string,
  remoteSha: string,
  localSha: string,
): Promise<RemoteAncestry> {
  try {
    await run(`git merge-base --is-ancestor ${shellEscape(remoteSha)} ${shellEscape(localSha)}`, { cwd: worktree });
    return { status: 'ancestor' };
  } catch (err) {
    // Exit 1 is git's documented "not an ancestor"; other non-zero statuses are errors.
    if ((err as { code?: unknown } | null)?.code === 1) return { status: 'diverged' };
    const detail = shortDetail(err);
    // A remote commit absent from the local object store cannot be contained in local HEAD.
    if (MISSING_OBJECT_MARKERS.some((marker) => detail.toLowerCase().includes(marker))) return { status: 'diverged' };
    return { status: 'unreadable', detail };
  }
}
