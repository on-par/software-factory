// src/harness/opencode-version.ts — OpenCode CLI major-version probe (#2878).

import type { ExecFn } from '../utils/exec.js';

export type OpenCodeVersionProbe = () => Promise<number | undefined>;

/** First `X.Y.Z` in `opencode --version` output -> X; undefined when none. */
export function parseOpenCodeMajor(stdout: string): number | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : undefined;
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
