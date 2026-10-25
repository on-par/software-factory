// packages/cli/src/cli/doctor-clock-skew.ts — the `clock skew` doctor row: local clock vs GitHub's Date header (#3149).

import { measureGithubClockSkew } from '@on-par/factory-core/internal';

import type { DoctorCheck } from './doctor.js';

const NAME = 'clock skew';

/** `{ measured: false }` (no GitHub token) yields no row; a null skew means the Date header could not be read. */
export function clockSkewCheck(
  skew: { measured: false } | { measured: true; skewMs: number | null },
  maxClockSkewMs: number,
): DoctorCheck | null {
  if (!skew.measured) return null;
  if (skew.skewMs === null) {
    return {
      name: NAME,
      ok: false,
      optional: true,
      detail: 'could not read the GitHub Date header',
      fix: 'check GitHub API reachability',
    };
  }
  const seconds = skew.skewMs / 1000;
  const signed = `${seconds > 0 ? '+' : ''}${seconds}`;
  const detail = `local clock is ${signed}s vs GitHub (max ${maxClockSkewMs / 1000}s)`;
  if (Math.abs(skew.skewMs) > maxClockSkewMs) {
    return {
      name: NAME,
      ok: false,
      optional: true,
      detail: `${detail}; the stale-claim reaper refuses to reap`,
      fix: 'sync this host clock with NTP (sntp/timedatectl)',
    };
  }
  return { name: NAME, ok: true, detail };
}

/** Measures skew uncached, only when a GitHub token exists; a failed call is a null skew. */
export async function measureDoctorClockSkew(rt: {
  hasGitHubToken: () => boolean;
  getOctokit: () => Parameters<typeof measureGithubClockSkew>[0];
}): Promise<{ measured: false } | { measured: true; skewMs: number | null }> {
  if (!rt.hasGitHubToken()) return { measured: false };
  return { measured: true, skewMs: await measureGithubClockSkew(rt.getOctokit()).catch(() => null) };
}
