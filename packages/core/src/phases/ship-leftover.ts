import type { EventKind } from '../events/kinds.js';
import { shellEscape } from '../utils/index.js';
import type { WorkKey } from '../work/work-key.js';
import { type CommandRunner, shortDetail } from './ship-git.js';

export async function commitLeftoverBuildOutput(o: {
  run: CommandRunner;
  worktree: string;
  branch: string;
  issue?: WorkKey;
  statusLines: string[];
  log: (type: EventKind, msg: string) => void;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const paths = o.statusLines
    .slice(0, 5)
    .map((line) => line.slice(3))
    .join(', ');
  const remainder = o.statusLines.length > 5 ? ` (+${o.statusLines.length - 5} more)` : '';
  o.log('ship', `recovering leftover build output on ${o.branch}: ${paths}${remainder}`);
  try {
    await o.run('git add -A', { cwd: o.worktree });
    try {
      await o.run('git diff --cached --quiet', { cwd: o.worktree });
      o.log('ship', 'nothing staged after git add -A; no leftover commit');
      return { ok: true };
    } catch (err) {
      const code = (err as { code?: unknown } | null | undefined)?.code;
      if (code !== 1) throw err;
    }
    await o.run(
      `git commit -m ${shellEscape(`chore(ship): commit build output left after check${o.issue === undefined ? '' : ` (#${o.issue})`}`)}`,
      {
        cwd: o.worktree,
      },
    );
  } catch (err) {
    return { ok: false, reason: `could not commit leftover build output: ${shortDetail(err)}` };
  }
  o.log('ship', `committed ${o.statusLines.length} uncommitted path(s) left after check on ${o.branch}`);
  return { ok: true };
}
