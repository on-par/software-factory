import type { CheckSummary } from '../types/index.js';
import type { CommandResult } from '../utils/command-runner.js';

/** Line scripts/verify.sh prints when its probe finds a loopback/TMPDIR bind denied with EPERM (#3332). */
export const VERIFY_SANDBOX_ENV_MARKER = 'verify: ENVIRONMENT ERROR: loopback bind denied (EPERM)';
/** Exit code verify.sh uses for the marker (BSD EX_CONFIG). */
export const VERIFY_SANDBOX_ENV_EXIT = 78;
/** Prefix of the line a BUILD worker prints to report the marker and stop. */
export const ENV_ERROR_PREFIX = 'ENV-ERROR:';

/** First worker-output line that starts with `ENV-ERROR:`. */
export function envErrorLine(output: string): string | undefined {
  return output
    .split('\n')
    .find((line) => line.startsWith(ENV_ERROR_PREFIX))
    ?.trimEnd();
}

/** The marker when a command exited 78 and printed it; plain exit 78 or a bare marker is not enough. */
export function sandboxEnvMarkerLine(r: Pick<CommandResult, 'exitCode' | 'stdout' | 'stderr'>): string | undefined {
  if (r.exitCode !== VERIFY_SANDBOX_ENV_EXIT) return undefined;
  const found = `${r.stdout}\n${r.stderr}`.split('\n').some((line) => line.includes(VERIFY_SANDBOX_ENV_MARKER));
  return found ? VERIFY_SANDBOX_ENV_MARKER : undefined;
}

/** The tests checker's sandbox marker from a CHECK summary, if its FAIL carries one. */
export function sandboxEnvFromSummary(summary: CheckSummary): string | undefined {
  return summary.results.find((r) => r.checker === 'tests' && r.result === 'FAIL' && r.sandboxEnv)?.sandboxEnv;
}

export function sandboxEnvParkMessage(phase: 'build' | 'check', line: string): string {
  return `${phase === 'build' ? 'BUILD' : 'CHECK tests'} hit a sandbox environment error: ${line} — the sandbox denied a loopback bind (127.0.0.1 / TMPDIR pipe); this is not a code failure, so no rework or re-run was attempted (see #3081).`;
}
