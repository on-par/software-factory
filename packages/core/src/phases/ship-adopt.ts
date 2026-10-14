import type { EventKind } from '../events/kinds.js';
import { shellEscape } from '../utils/index.js';

type CommandRunner = (command: string, options?: { cwd?: string; timeout?: number }) => Promise<{ stdout: string }>;

/**
 * Push an adopted PR branch's new commits (#2253). Fails closed when HEAD still equals the adopted
 * head: with no new commit there is nothing to push, and watching CI would silently re-run the
 * failed checks (#1882). The push is a plain fast-forward — no force, no lease — so a branch that
 * moved on the remote is rejected rather than overwritten.
 */
export async function pushAdoptedHead(opts: {
  run: CommandRunner;
  worktree: string;
  branch: string;
  prNumber: number;
  adoptedHeadSha: string;
  log: (type: EventKind, msg: string) => void;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { run, worktree, branch, prNumber, adoptedHeadSha, log } = opts;
  const fail = (reason: string): { ok: false; reason: string } => {
    log('ship', `${reason} — aborting before CI watch`);
    return { ok: false, reason };
  };

  let head: string;
  try {
    head = (await run('git rev-parse HEAD', { cwd: worktree })).stdout.trim();
  } catch (err) {
    return fail(`could not read HEAD of adopted PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (head === adoptedHeadSha) {
    return fail(
      `adopted PR #${prNumber} has no new commit over ${adoptedHeadSha.slice(0, 12)}; not re-watching CI (#1882)`,
    );
  }

  try {
    await run(`git push -u origin ${shellEscape(branch)}`, { cwd: worktree });
  } catch (err) {
    return fail(
      `push to adopted PR #${prNumber} branch ${branch} was rejected or failed (the remote may have moved): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let remote: string;
  try {
    const { stdout } = await run(`git ls-remote origin ${shellEscape(`refs/heads/${branch}`)}`, { cwd: worktree });
    remote = stdout.trim().split(/\s+/)[0] ?? '';
  } catch (err) {
    return fail(
      `could not read origin/${branch} after pushing to adopted PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (remote !== head) {
    return fail(
      `origin/${branch} is ${remote || 'unreadable'} after the push but local HEAD is ${head} for adopted PR #${prNumber}`,
    );
  }
  log('ship', `pushed ${head} onto adopted PR #${prNumber}`);
  return { ok: true };
}
