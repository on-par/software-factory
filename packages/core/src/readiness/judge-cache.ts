// src/readiness/judge-cache.ts — on-disk cache of valid readiness verdicts, one file per key (#3467)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ReadinessVerdict } from './judge.js';

export interface ReadinessCacheEntry {
  schemaVersion: 1;
  promptVersion: string;
  bodyHash: string;
  model: string;
  verdict: ReadinessVerdict;
  createdAt: string;
}

/** Stable 32-hex key over the prompt version, the prepared title and the prepared body. */
export function readinessCacheKey(promptVersion: string, title: string, preparedBody: string): string {
  return createHash('sha256').update(`${promptVersion}\0${title}\0${preparedBody}`).digest('hex').slice(0, 32);
}

/** Read an entry. Any I/O or shape problem counts as a miss (ADR-0140). The verdict is not schema-checked here. */
export function readCachedVerdict(dir: string, key: string): ReadinessCacheEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const entry = parsed as Partial<ReadinessCacheEntry>;
    if (entry.schemaVersion !== 1 || entry.bodyHash !== key) return undefined;
    if (typeof entry.verdict !== 'object' || entry.verdict === null) return undefined;
    return entry as ReadinessCacheEntry;
  } catch {
    return undefined;
  }
}

/** Atomic temp-file + rename write. Never throws. */
export function writeCachedVerdict(dir: string, key: string, entry: ReadinessCacheEntry): void {
  const tmp = join(dir, `.${key}.${process.pid}.${Date.now()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, join(dir, `${key}.json`));
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
  }
}
