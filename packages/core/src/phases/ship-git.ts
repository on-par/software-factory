// packages/core/src/phases/ship-git.ts — push-failure and remote-head helpers for SHIP

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { CommandRunner } from './ship-git-detail.js';

const defaultRun: CommandRunner = promisify(execCb);

/** Wraps a runner so no command starts once the lane's claim is lost (#3146): push and remote-head checks refuse to run. */
export function claimGuardedRunner(signal: AbortSignal, run: CommandRunner = defaultRun): CommandRunner {
  return (command, options) => {
    signal.throwIfAborted();
    return run(command, options);
  };
}

export type { CommandRunner } from './ship-git-detail.js';
export { checkRemoteIsAncestor, describePushFailure, shortDetail } from './ship-git-detail.js';
export { pushAndVerifyRemoteHead, readRemoteBranchSha, verifyRemoteHead } from './ship-git-remote.js';
