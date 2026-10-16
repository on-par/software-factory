// packages/core/src/phases/ship-git.ts — push-failure and remote-head helpers for SHIP

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

/** The result of comparing the pushed branch's remote head against local HEAD (#735). */
type RemoteHeadCheck =
  | { status: 'match'; localSha: string; remoteSha: string }
  | { status: 'mismatch'; localSha: string; remoteSha: string }
  | { status: 'unreadable'; localSha?: string; remoteSha?: string; detail: string };

/** Same flatten-and-bound shaping as {@link describePushFailure}, kept separate so that
 *  function's asserted output never changes. */
export function shortDetail(err: unknown): string {
  const raw = (err as { stderr?: unknown } | null | undefined)?.stderr;
  const stderr = typeof raw === 'string' ? raw : '';
  const text = stderr.trim() || (err instanceof Error ? err.message : String(err));
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_REMOTE_HEAD_DETAIL) || 'no error output';
}

/** The SHA on the `refs/heads/<branch>` line of `git ls-remote` output. `--heads origin <branch>`
 *  is a suffix pattern, so it can list more than one ref — match the ref name exactly rather than
 *  trusting the first line. */
function parseRemoteHeadSha(stdout: string, branch: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === `refs/heads/${branch}` && sha) return sha;
  }
  return undefined;
}

/** origin/<branch>'s current SHA, `null` when the branch is absent, or the failure detail (#1869). */
export async function readRemoteBranchSha(
  run: CommandRunner,
  worktree: string,
  branch: string,
): Promise<{ status: 'ok'; sha: string | null } | { status: 'unreadable'; detail: string }> {
  try {
    const { stdout } = await run(`git ls-remote --heads origin ${shellEscape(branch)}`, { cwd: worktree });
    return { status: 'ok', sha: parseRemoteHeadSha(stdout, branch) ?? null };
  } catch (err) {
    return { status: 'unreadable', detail: shortDetail(err) };
  }
}

/**
 * A zero-exit push is not proof the remote branch actually carries this run's commits — a
 * concurrent push or an update that silently applied nothing leaves the remote head elsewhere,
 * and a PR opened against it would advertise work that is not there (#735).
 */
export async function verifyRemoteHead(run: CommandRunner, worktree: string, branch: string): Promise<RemoteHeadCheck> {
  let localSha: string | undefined;
  try {
    const { stdout } = await run('git rev-parse HEAD', { cwd: worktree });
    localSha = stdout.trim();
  } catch (err) {
    return { status: 'unreadable', detail: shortDetail(err) };
  }
  if (!localSha) return { status: 'unreadable', detail: 'git rev-parse HEAD produced no SHA' };

  let listing: string;
  try {
    const { stdout } = await run(`git ls-remote --heads origin ${shellEscape(branch)}`, { cwd: worktree });
    listing = stdout;
  } catch (err) {
    return { status: 'unreadable', localSha, detail: shortDetail(err) };
  }

  const remoteSha = parseRemoteHeadSha(listing, branch);
  if (!remoteSha) return { status: 'unreadable', localSha, detail: `no refs/heads/${branch} on origin` };
  return remoteSha === localSha
    ? { status: 'match', localSha, remoteSha }
    : { status: 'mismatch', localSha, remoteSha };
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

/** Outcome of one push followed by a remote-head check, the single verified push site for SHIP (#734/#735/#1813). */
export type VerifiedPush =
  | { status: 'pushed'; localSha: string; remoteSha: string }
  | { status: 'push-failed'; kind: PushFailureKind; detail: string }
  | { status: 'mismatch'; localSha: string; remoteSha: string }
  | { status: 'unreadable'; localSha?: string; detail: string };

export async function pushAndVerifyRemoteHead(
  run: CommandRunner,
  worktree: string,
  branch: string,
  pushCmd: string,
): Promise<VerifiedPush> {
  try {
    await run(pushCmd, { cwd: worktree });
  } catch (err) {
    return { status: 'push-failed', ...describePushFailure(err) };
  }
  const head = await verifyRemoteHead(run, worktree, branch);
  if (head.status === 'match') return { status: 'pushed', localSha: head.localSha, remoteSha: head.remoteSha };
  if (head.status === 'mismatch') return head;
  return { status: 'unreadable', localSha: head.localSha, detail: head.detail };
}
