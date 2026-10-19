import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    factoryTmpSandbox: string;
  }
}

/** Top-level TMPDIR name prefixes that factory tests create. Longest first so entries group under the longest match. */
export const FACTORY_TEST_TMP_PREFIXES = [
  'build-phase-test-',
  'plan-phase-test-',
  'phase-snapshot-',
  'upstream-send-',
  'sf-docker-test-',
  'sf-lane-test-',
  'repo-slug-',
  'run-state-',
  'checkout-',
  'feedback-',
  'filing-',
  'factory-',
] as const;

/** Prefixes that live factory lanes create in the shared real TMPDIR (#3173). Tests never create these there:
 *  setup-env.ts points TMPDIR at the per-run sandbox, so a fresh one in the real TMPDIR belongs to a concurrent process. */
export const FACTORY_RUNTIME_TMP_PREFIXES = [
  'factory-claude-prompt-',
  'factory-codex-',
  'factory-codex-out-',
  'factory-pi-prompt-',
  'factory-opencode-prompt-',
  'factory-harness-check-',
  'factory-baseline-',
  'factory-command-',
] as const;

export interface TempLeak {
  prefix: string;
  entries: string[];
}

const MAX_NAMES_PER_PREFIX = 5;

export function findLeakedTempEntries(
  before: ReadonlySet<string>,
  after: readonly string[],
  prefixes: readonly string[] = FACTORY_TEST_TMP_PREFIXES,
  ignorePrefixes: readonly string[] = FACTORY_RUNTIME_TMP_PREFIXES,
): TempLeak[] {
  const byPrefix = new Map<string, string[]>();
  for (const name of after) {
    if (before.has(name)) continue;
    if (ignorePrefixes.some((p) => name.startsWith(p))) continue;
    const prefix = [...prefixes].sort((a, b) => b.length - a.length).find((p) => name.startsWith(p));
    if (prefix === undefined) continue;
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
  }
  return [...byPrefix.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([prefix, entries]) => ({ prefix, entries }));
}

export function formatTempLeakMessage(leaks: readonly TempLeak[]): string {
  const total = leaks.reduce((sum, leak) => sum + leak.entries.length, 0);
  const groups = leaks.map((leak) => {
    const shown = leak.entries.slice(0, MAX_NAMES_PER_PREFIX).join(', ');
    const more = leak.entries.length > MAX_NAMES_PER_PREFIX ? ', …' : '';
    return `${leak.prefix} (${leak.entries.length}: ${shown}${more})`;
  });
  return `Test run leaked ${total} temp ${total === 1 ? 'entry' : 'entries'} into ${tmpdir()}: ${groups.join(', ')}`;
}

function mtimeMs(path: string): number | undefined {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

export default function setup(project: Pick<TestProject, 'provide'>): () => Promise<void> {
  const realTmp = realpathSync(tmpdir());
  const startedAt = Date.now();
  const before = new Set(readdirSync(realTmp));
  const sandbox = mkdtempSync(join(realTmp, `factory-test-tmp-${process.pid}-`));
  project.provide('factoryTmpSandbox', sandbox);
  return async () => {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
    const fresh = readdirSync(realTmp).filter((name) => {
      if (before.has(name)) return false;
      const mtime = mtimeMs(join(realTmp, name));
      return mtime !== undefined && mtime >= startedAt - 1000;
    });
    const leaks = findLeakedTempEntries(before, fresh);
    if (leaks.length === 0) return;
    const message = formatTempLeakMessage(leaks);
    if (process.env.FACTORY_TMP_LEAK_GUARD === '0') {
      console.warn(message);
      return;
    }
    throw new Error(message);
  };
}
