import { VERIFY_SANDBOX_ENV_EXIT } from '../environment/sandbox-env.js';
import type { CheckerOutput } from '../types/index.js';

export type InconclusiveCause = 'timeout' | 'environment' | 'missing-command' | 'killed' | 'checker-error';

const SHELL_NOT_EXECUTABLE_EXIT = 126;
const SHELL_COMMAND_NOT_FOUND_EXIT = 127;
const NO_EXIT_CODE_KILLED_BY_SIGNAL_OR_SPAWN_FAILED = -1;

export function inconclusiveCause(fail: {
  timedOut?: boolean;
  exitCode?: number;
  checkerError?: boolean;
}): InconclusiveCause | undefined {
  if (fail.timedOut === true) return 'timeout';
  if (fail.checkerError === true) return 'checker-error';
  if (fail.exitCode === VERIFY_SANDBOX_ENV_EXIT) return 'environment';
  if (fail.exitCode === SHELL_NOT_EXECUTABLE_EXIT || fail.exitCode === SHELL_COMMAND_NOT_FOUND_EXIT)
    return 'missing-command';
  if (fail.exitCode === NO_EXIT_CODE_KILLED_BY_SIGNAL_OR_SPAWN_FAILED) return 'killed';
  return undefined;
}

const LEGACY_CHECKER_ERROR = /^unexpected checker error:/;
const LEGACY_PWSH_MISSING = /pwsh \(PowerShell 7\) is not on PATH/;

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
