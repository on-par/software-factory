// src/harness/opencode-version.ts — OpenCode CLI version probe and supported range (#2878, #2880).

import type { ExecFn } from '../utils/exec.js';

export type OpenCodeVersionProbe = () => Promise<number | undefined>;

/** Versions the OpenCode adapter supports (#2880). Lower bound inclusive, upper exclusive. */
export const OPENCODE_SUPPORTED_RANGE = '>=1.18.0 <2.1.0';
/** The OpenCode version docs/agents.md and the nightly job test against (#2880). */
export const OPENCODE_PINNED_VERSION = '1.18.28';
export const OPENCODE_PINNED_INSTALL = `npm install -g opencode-ai@${OPENCODE_PINNED_VERSION}`;

export type OpenCodeVersion = readonly [major: number, minor: number, patch: number];

const SUPPORTED_MIN: OpenCodeVersion = [1, 18, 0];
const SUPPORTED_MAX_EXCLUSIVE: OpenCodeVersion = [2, 1, 0];

/** First `X.Y.Z` in `opencode --version` output -> [X, Y, Z]; undefined when none. */
export function parseOpenCodeVersion(stdout: string): OpenCodeVersion | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  if (!match) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parts.every(Number.isFinite) ? parts : undefined;
}

/** First `X.Y.Z` in `opencode --version` output -> X; undefined when none. */
export function parseOpenCodeMajor(stdout: string): number | undefined {
  return parseOpenCodeVersion(stdout)?.[0];
}

function compareVersions(a: OpenCodeVersion, b: OpenCodeVersion): number {
  for (let i = 0; i < 3; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isOpenCodeVersionSupported(version: OpenCodeVersion): boolean {
  return compareVersions(version, SUPPORTED_MIN) >= 0 && compareVersions(version, SUPPORTED_MAX_EXCLUSIVE) < 0;
}

/** Runs `opencode --version`; never throws (any error -> undefined). */
export async function probeOpenCodeMajor(execFn: ExecFn): Promise<number | undefined> {
  try {
    const { stdout } = await execFn('opencode --version', { timeoutMs: 10_000 });
    return parseOpenCodeMajor(stdout);
  } catch {
    return undefined;
  }
}
