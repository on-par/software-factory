import { execSync } from 'node:child_process';

const HARNESS_PROBE_TIMEOUT_MS = 10_000;

/** Run a declared harness probe command. Returns null on exit 0, else a one-line failure detail. */
export function runHarnessProbe(cmd: string): string | null {
  try {
    execSync(cmd, { stdio: 'pipe', shell: '/bin/bash', timeout: HARNESS_PROBE_TIMEOUT_MS });
    return null;
  } catch (e) {
    const err = e as { status?: number | null; signal?: string | null; code?: string; stderr?: Buffer | string };
    if (err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT')
      return `timed out after ${HARNESS_PROBE_TIMEOUT_MS / 1000}s`;
    const firstLine = (err.stderr?.toString() ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '');
    return `exit ${err.status ?? '?'}${firstLine ? `: ${firstLine}` : ''}`;
  }
}
