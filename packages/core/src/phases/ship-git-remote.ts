import { shellEscape } from '../utils/index.js';
import { type CommandRunner, describePushFailure, type PushFailureKind, shortDetail } from './ship-git-detail.js';

type RemoteHeadCheck =
  | { status: 'match'; localSha: string; remoteSha: string }
  | { status: 'mismatch'; localSha: string; remoteSha: string }
  | { status: 'unreadable'; localSha?: string; remoteSha?: string; detail: string };

function parseRemoteHeadSha(stdout: string, branch: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === `refs/heads/${branch}` && sha) return sha;
  }
  return undefined;
}

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
