// src/checkers/inconclusive.ts — a checker FAIL that never reached a code verdict (timeout, environment, setup)

import { VERIFY_SANDBOX_ENV_EXIT } from '../environment/sandbox-env.js';

export type InconclusiveCause = 'timeout' | 'environment' | 'missing-command' | 'killed';

/** Why a FAIL is an environment or setup failure, not a test failure; undefined for a genuine failure.
 *  Exit 78 is the verify.sh environment-probe convention (EX_CONFIG); 126/127 are the shell's
 *  not-executable / command-not-found; -1 is no exit code (killed by a signal or spawn failure). */
export function inconclusiveCause(fail: { timedOut?: boolean; exitCode?: number }): InconclusiveCause | undefined {
  if (fail.timedOut === true) return 'timeout';
  if (fail.exitCode === VERIFY_SANDBOX_ENV_EXIT) return 'environment';
  if (fail.exitCode === 126 || fail.exitCode === 127) return 'missing-command';
  if (fail.exitCode === -1) return 'killed';
  return undefined;
}

/** One-line label for a cause, e.g. `timeout after 300s`, `environment error (exit 78)`. */
export function describeInconclusive(cause: InconclusiveCause, exitCode?: number, timeoutSeconds?: number): string {
  switch (cause) {
    case 'timeout':
      return timeoutSeconds === undefined ? 'timeout' : `timeout after ${timeoutSeconds}s`;
    case 'environment':
      return `environment error (exit ${exitCode})`;
    case 'missing-command':
      return `command not found or not executable (exit ${exitCode})`;
    case 'killed':
      return 'no exit code (killed by a signal or failed to start)';
  }
}
