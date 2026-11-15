import { shellEscape } from '../utils/index.js';

export type CommandRunner = (
  command: string,
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string }>;

export type PushFailureKind = 'non-fast-forward' | 'network' | 'unknown';

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

export function describePushFailure(err: unknown): { kind: PushFailureKind; detail: string } {
  const raw = (err as { stderr?: unknown } | null | undefined)?.stderr;
  const stderr = typeof raw === 'string' ? raw : '';
  const text = stderr.trim() || (err instanceof Error ? err.message : String(err));
  const detail = text.replace(/\s+/g, ' ').trim().slice(0, MAX_PUSH_ERROR_DETAIL);
  return { kind: classifyPushFailure(detail), detail: detail || 'no error output' };
}

const MAX_REMOTE_HEAD_DETAIL = 200;

export function shortDetail(err: unknown): string {
  const output = err as { stderr?: unknown; stdout?: unknown } | null | undefined;
  const rawStderr = output?.stderr;
  const rawStdout = output?.stdout;
  const stderr = typeof rawStderr === 'string' ? rawStderr.trim() : '';
  const stdout = typeof rawStdout === 'string' ? rawStdout.trim() : '';
  const text = stderr || stdout || (err instanceof Error ? err.message : String(err));
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_REMOTE_HEAD_DETAIL) || 'no error output';
}

export type RemoteAncestry = { status: 'ancestor' } | { status: 'diverged' } | { status: 'unreadable'; detail: string };

const GIT_NOT_AN_ANCESTOR_EXIT_CODE = 1;

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
    if ((err as { code?: unknown } | null)?.code === GIT_NOT_AN_ANCESTOR_EXIT_CODE) return { status: 'diverged' };
    const detail = shortDetail(err);
    if (MISSING_OBJECT_MARKERS.some((marker) => detail.toLowerCase().includes(marker))) return { status: 'diverged' };
    return { status: 'unreadable', detail };
  }
}
