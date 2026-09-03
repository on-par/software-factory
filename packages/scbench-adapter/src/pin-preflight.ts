// packages/scbench-adapter/src/pin-preflight.ts — pinned checkout/catalog preflight (#1139).
import { existsSync } from 'node:fs';

import { z } from 'zod';

import { AdapterError } from './checkpoint.js';
import type { ExecFn } from './workspace.js';

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const SHA_EXPECTATION = 'a full-length (40 hex char) git SHA';

function fullSha() {
  return z.string(SHA_EXPECTATION).regex(FULL_SHA_RE, SHA_EXPECTATION);
}

const PinFileSchema = z.object({
  commit: fullSha(),
  problems: z.object({ commit: fullSha() }, 'an object'),
});

/** The declared shape of `scbench.pin.json`, derived from —  never declared
 *  alongside — `PinFileSchema`. Extra keys (repo, pinnedAt, …) are tolerated. */
export type PinFile = z.infer<typeof PinFileSchema>;

/** Render one zod issue as the AdapterError message this parser has always
 *  thrown, mirroring `loadBaselineConfig`'s pattern. */
function describePinIssue(issue: { path: PropertyKey[]; message: string }, pin: Record<string, unknown>): string {
  const path = issue.path.join('.');
  if (issue.path.length === 1 && !(String(issue.path[0]) in pin)) {
    return `scbench.pin.json missing required field "${path}"`;
  }
  return `scbench.pin.json field "${path}" must be ${issue.message}`;
}

/** Parse + validate the pinned-commit shape of `scbench.pin.json`. Throws
 *  AdapterError naming the first offending field. */
export function parsePinFile(raw: string): PinFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AdapterError(`scbench.pin.json is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AdapterError('scbench.pin.json must be a JSON object');
  }
  const pin = parsed as Record<string, unknown>;

  const result = PinFileSchema.safeParse(pin);
  if (!result.success) {
    throw new AdapterError(describePinIssue(result.error.issues[0], pin));
  }
  return result.data;
}

/** One pinned input to check — the env var name (used in every rendered
 *  message), its current value, and the commit it must be pinned to. */
export interface PinnedInputSpec {
  /** Env-var name used in every rendered message, e.g. 'SCBENCH_CHECKOUT'. */
  input: string;
  /** The env var's value; undefined/empty means unset. */
  path: string | undefined;
  expectedCommit: string;
}

export interface PinPreflightResult {
  input: string;
  ok: boolean;
  detail: string;
}

export interface PinPreflightOutcome {
  ok: boolean;
  results: PinPreflightResult[];
}

function countPorcelainLines(porcelain: string): number {
  return porcelain
    .trim()
    .split('\n')
    .filter((line) => line.length > 0).length;
}

/** Checks one pinned input against a live checkout: unset/missing/not-a-git-
 *  checkout/dirty/HEAD-mismatch, in that order, returning at the first
 *  failure. Never writes; only shells out through `deps.exec` (argv-based,
 *  no shell — same contract as workspace.ts). */
export async function checkPinnedInput(spec: PinnedInputSpec, deps: { exec: ExecFn }): Promise<PinPreflightResult> {
  const { input, path, expectedCommit } = spec;

  if (path === undefined || path === '') {
    return { input, ok: false, detail: 'is not set' };
  }
  if (!existsSync(path)) {
    return { input, ok: false, detail: `path does not exist: ${path}` };
  }

  const gitDir = await deps.exec(['git', 'rev-parse', '--git-dir'], { cwd: path });
  if (gitDir.exitCode !== 0) {
    const stderr = gitDir.stderr.trim();
    return {
      input,
      ok: false,
      detail: `not a git checkout: ${path}${stderr.length > 0 ? ` (${stderr})` : ''}`,
    };
  }

  const status = await deps.exec(['git', 'status', '--porcelain'], { cwd: path });
  if (status.exitCode !== 0) {
    return { input, ok: false, detail: `git status failed: ${status.stderr || status.stdout}` };
  }
  if (status.stdout.trim().length > 0) {
    const n = countPorcelainLines(status.stdout);
    return { input, ok: false, detail: `working tree is dirty (${n} uncommitted change(s))` };
  }

  const head = await deps.exec(['git', 'rev-parse', 'HEAD'], { cwd: path });
  if (head.exitCode !== 0) {
    return { input, ok: false, detail: `could not resolve HEAD: ${head.stderr || head.stdout}` };
  }
  const actual = head.stdout.trim();
  if (actual !== expectedCommit) {
    return {
      input,
      ok: false,
      detail: `HEAD ${actual} does not match pinned commit ${expectedCommit}`,
    };
  }

  return { input, ok: true, detail: `HEAD matches pinned commit ${expectedCommit}, working tree clean` };
}

/** Runs `checkPinnedInput` for every spec sequentially — no short-circuit —
 *  so a single run reports every failing input, and exactly the failing ones. */
export async function runPinPreflight(
  specs: readonly PinnedInputSpec[],
  deps: { exec: ExecFn },
): Promise<PinPreflightOutcome> {
  const results: PinPreflightResult[] = [];
  for (const spec of specs) {
    results.push(await checkPinnedInput(spec, deps));
  }
  return { ok: results.every((r) => r.ok), results };
}
