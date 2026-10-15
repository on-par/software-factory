// src/models/pi-auth.ts — `pi auth check` probe for factory models --doctor (#2903)

import { type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns, spawnSync } from 'node:child_process';

const PI_AUTH_TIMEOUT_MS = 10_000;

/** Result of `pi auth check` (#2903): ready=exit 0, not_ready=exit 1, invalid=exit 2; anything else is unknown. */
export type PiAuthStatus = 'ready' | 'not_ready' | 'invalid' | 'unknown';

const PI_LOGIN_HINT = 'run `pi` then `/login <provider>`, or export the provider key';

const PI_AUTH_EXPECTED: Readonly<Record<number, PiAuthStatus>> = { 0: 'ready', 1: 'not_ready', 2: 'invalid' };

/** The slice of `spawnSync` that runPiAuthCheck uses; injectable in tests. */
export type PiSpawn = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => Pick<SpawnSyncReturns<string>, 'status' | 'signal' | 'stdout' | 'error'>;

/** Runs `pi auth check --model <m> --no-refresh` (no model call, no token refresh). The exit code and the
 *  stdout token must agree, so an older pi without the subcommand reads as unknown, not not_ready. */
export function runPiAuthCheck(providerModel: string, spawn: PiSpawn = spawnSync): PiAuthStatus {
  try {
    const res = spawn('pi', ['auth', 'check', '--model', providerModel, '--no-refresh'], {
      encoding: 'utf8',
      timeout: PI_AUTH_TIMEOUT_MS,
      stdio: 'pipe',
      // Mirrors the pi harness (ADR-0163): DEEPSEEK_API_KEY is never passed to pi.
      env: { ...process.env, DEEPSEEK_API_KEY: undefined },
    });
    if (res.error || res.signal || res.status === null) return 'unknown';
    const expected = PI_AUTH_EXPECTED[res.status];
    if (!expected) return 'unknown';
    const token = String(res.stdout ?? '')
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .find((line) => line !== '');
    return token === expected ? expected : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Maps a `pi auth check` status to the reachability fields of a ModelDiagnosis row. */
export function piAuthOutcome(
  status: PiAuthStatus,
  target: string,
  okLabel: string,
): { reachable: boolean; unverified: boolean; reason: string } {
  switch (status) {
    case 'ready':
      return { reachable: true, unverified: false, reason: `ok (${okLabel})` };
    case 'not_ready':
      return {
        reachable: false,
        unverified: true,
        reason: `unverified — no auth evidence: ${okLabel} auth check not_ready for ${target} — ${PI_LOGIN_HINT}`,
      };
    case 'invalid':
      return {
        reachable: false,
        unverified: false,
        reason: `${okLabel} reports invalid credentials for ${target} — ${PI_LOGIN_HINT}`,
      };
    default:
      return {
        reachable: false,
        unverified: true,
        reason: `unverified — could not run \`pi auth check\` for ${target} (upgrade pi or check it runs)`,
      };
  }
}
