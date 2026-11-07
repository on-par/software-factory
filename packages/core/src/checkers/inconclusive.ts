// src/checkers/inconclusive.ts — a checker FAIL that never reached a code verdict (timeout, environment, setup)

import { VERIFY_SANDBOX_ENV_EXIT } from '../environment/sandbox-env.js';
import type { CheckerOutput } from '../types/index.js';

export type InconclusiveCause = 'timeout' | 'environment' | 'missing-command' | 'killed' | 'checker-error';

/** Why a FAIL is an environment or setup failure, not a test failure; undefined for a genuine failure.
 *  Exit 78 is the verify.sh environment-probe convention (EX_CONFIG); 126/127 are the shell's
 *  not-executable / command-not-found; -1 is no exit code (killed by a signal or spawn failure);
 *  checkerError is the checker's own catch branch (it crashed before running or reading the command).
 *  Exit 137/143 (SIGKILL/SIGTERM reported by the verify shell, e.g. an OOM-killed test worker) stay a
 *  genuine failure on purpose: a crash inside the suite can be caused by the code under test. */
export function inconclusiveCause(fail: {
  timedOut?: boolean;
  exitCode?: number;
  checkerError?: boolean;
}): InconclusiveCause | undefined {
  if (fail.timedOut === true) return 'timeout';
  if (fail.checkerError === true) return 'checker-error';
  if (fail.exitCode === VERIFY_SANDBOX_ENV_EXIT) return 'environment';
  if (fail.exitCode === 126 || fail.exitCode === 127) return 'missing-command';
  if (fail.exitCode === -1) return 'killed';
  return undefined;
}

/** Details of a FAIL recorded before `failedCommand`/`checkerError` existed that still never reached a verdict. */
const LEGACY_CHECKER_ERROR = /^unexpected checker error:/;
const LEGACY_PWSH_MISSING = /pwsh \(PowerShell 7\) is not on PATH/;

/** inconclusiveCause for a checker output: a FAIL only, including entries cached before the fields existed. */
export function inconclusiveOutputCause(output: CheckerOutput): InconclusiveCause | undefined {
  if (output.result !== 'FAIL') return undefined;
  const cause = inconclusiveCause({
    timedOut: output.timedOut,
    exitCode: output.failedCommand?.exitCode,
    checkerError: output.checkerError,
  });
  if (cause !== undefined || output.failedCommand !== undefined) return cause;
  if (typeof output.sandboxEnv === 'string') return 'environment';
  const details = typeof output.details === 'string' ? output.details : '';
  if (LEGACY_CHECKER_ERROR.test(details)) return 'checker-error';
  if (LEGACY_PWSH_MISSING.test(details)) return 'missing-command';
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
    case 'checker-error':
      return 'the checker crashed before a verdict';
  }
}
