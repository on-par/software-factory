// Sandbox environment errors (#3332): a sandbox that denies loopback binds is not a code failure.
// scripts/verify.sh exits 78 with VERIFY_ENV_MARKER; a BUILD agent prints an ENV-ERROR: line.

export const VERIFY_ENV_MARKER = 'verify: ENVIRONMENT ERROR: loopback bind denied (EPERM)';
export const VERIFY_ENV_EXIT_CODE = 78;
export const ENV_ERROR_PREFIX = 'ENV-ERROR:';

/** The marker line (plus the following `verify: EPERM:` detail when present) of a verify.sh exit-78 run. */
export function sandboxEnvMarkerLine(r: { exitCode: number; stdout: string; stderr: string }): string | undefined {
  if (r.exitCode !== VERIFY_ENV_EXIT_CODE) return undefined;
  for (const text of [r.stdout, r.stderr]) {
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((l) => l.includes(VERIFY_ENV_MARKER));
    if (at < 0) continue;
    const marker = lines[at]!.trim();
    const detail = lines[at + 1]?.trim();
    return detail?.startsWith('verify: EPERM:') ? `${marker} — ${detail}` : marker;
  }
  return undefined;
}

/** The first line of a worker's output that starts with `ENV-ERROR:`. */
export function envErrorLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .find((l) => l.startsWith(ENV_ERROR_PREFIX))
    ?.trim();
}

export function sandboxEnvParkMessage(phase: 'BUILD' | 'CHECK', line: string): string {
  return `${phase} hit a sandbox environment error: ${line} — the sandbox denied a loopback bind (EPERM); this is not a code failure, so no rework or re-run was attempted (see #3081)`;
}

/** The marker line of the first FAILed checker that carries one (#3332), else undefined. */
export function sandboxEnvFailure(results: readonly { result: string; sandboxEnv?: string }[]): string | undefined {
  return results.find((r) => r.result === 'FAIL' && r.sandboxEnv)?.sandboxEnv;
}
