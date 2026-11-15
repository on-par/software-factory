import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { CommandRunner } from './ship-git-detail.js';

const defaultRun: CommandRunner = promisify(execCb);

export function claimGuardedRunner(signal: AbortSignal, run: CommandRunner = defaultRun): CommandRunner {
  return (command, options) => {
    signal.throwIfAborted();
    return run(command, options);
  };
}

export type { CommandRunner } from './ship-git-detail.js';
export { checkRemoteIsAncestor, describePushFailure, shortDetail } from './ship-git-detail.js';
export { pushAndVerifyRemoteHead, readRemoteBranchSha, verifyRemoteHead } from './ship-git-remote.js';
