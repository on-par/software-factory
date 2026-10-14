// src/phases/build-blocker.ts — BUILD's BLOCKED_BY handling (#2317), split out of build.ts for the max-lines guard.
//
// A valid claim pushes the branch best-effort (so the park comment's branch is real) and returns the claim for
// runIssue to file. An invalid claim without an ESCALATE line falls back to an escalate result.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

import { parseBlockerClaim } from '../blockers/index.js';
import type { RouterResult } from '../router/index.js';
import type { EventKind } from '../events/kinds.js';
import { isEscalation, shellEscape } from '../utils/index.js';
import type { BuildResult } from './build.js';
import type { CommandRunner } from './ship-git.js';

const exec = promisify(execCb);

export async function blockerBuildResult(opts: {
  result: Pick<RouterResult, 'output' | 'model'>;
  route: BuildResult['route'];
  branch: string;
  worktree: string;
  publish: boolean;
  run?: CommandRunner;
  log: (type: EventKind, msg: string) => void;
}): Promise<BuildResult | undefined> {
  const { result, route, branch, worktree, log } = opts;
  const { output, model } = result;
  const claim = parseBlockerClaim(output);
  if (claim?.ok) {
    log('escalate', `build named a blocker: ${claim.line}`);
    if (opts.publish) {
      try {
        await (opts.run ?? exec)(`git push -u origin ${shellEscape(branch)}`, { cwd: worktree });
      } catch (err) {
        log('warn', `blocker park: push of ${branch} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ok: false, model, route, escalate: claim.line, blocker: claim.claim };
  }
  if (claim && !isEscalation(output)) {
    const reason = `invalid BLOCKED_BY claim: ${claim.reason}`;
    log('escalate', reason);
    return { ok: false, model, route, escalate: reason };
  }
  return undefined;
}
