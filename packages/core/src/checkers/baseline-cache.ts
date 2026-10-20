// src/checkers/baseline-cache.ts — per-base-SHA cache of baseline checker results (#1926)
//
// Issues in one lane usually share a base SHA, so re-running the same failing
// checker on the base for each issue repeats the same slow work. This file-backed
// cache is keyed by base SHA + a hash of the applied laneEnv + checker name. Each
// entry also carries a hash of the constitution's checker config, compared on read,
// so a config fix invalidates it (#2563). Config-validation FAILs are never cached.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { CheckerOutput, Constitution } from '../types/index.js';
import { isConfigCheckerOutput } from './index.js';

/** laneEnv keys that differ per lane lease or per run and do not describe the environment contract. */
export const BASELINE_ENV_VOLATILE_KEYS: readonly string[] = [
  'PORT',
  'FACTORY_APP_PORT',
  'FACTORY_BASE_URL',
  'SharedCompilationId',
];

/** First 16 hex chars of the SHA-256 of the sorted laneEnv entries, minus the volatile keys. */
export function hashBaselineEnv(env: Record<string, string> | undefined): string {
  const entries = Object.entries(env ?? {})
    .filter(([key]) => !BASELINE_ENV_VOLATILE_KEYS.includes(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

/** First 16 hex chars of the SHA-256 of the constitution's checker config: a config fix invalidates cached base results (#2563). */
export function hashBaselineCheckerConfig(constitution: Constitution | null): string {
  const config = {
    checkers: constitution?.checkers ?? null,
    requireTests: constitution?.requireTests === true,
    optionalCheckers: constitution?.optionalCheckers ?? [],
  };
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
}

interface BaselineCacheEntry {
  output: CheckerOutput;
  configHash: string;
  recordedAt: string;
}

interface BaselineCacheFile {
  version: 1;
  entries: Record<string, BaselineCacheEntry>;
}

function entryKey(baseSha: string, envHash: string, checker: string): string {
  return `${baseSha}:${envHash}:${checker}`;
}

export class BaselineCache {
  constructor(
    private file: string,
    private now: () => number = () => Date.now(),
  ) {}

  /** Cached base result for the checker, or undefined on a miss. */
  async get(baseSha: string, envHash: string, configHash: string, checker: string): Promise<CheckerOutput | undefined> {
    const data = await this.read();
    const entry = data.entries[entryKey(baseSha, envHash, checker)];
    if (entry?.configHash !== configHash) return undefined;
    const output = entry.output;
    if (typeof output !== 'object' || output === null) return undefined;
    if (output.checker !== checker) return undefined;
    if (output.result !== 'PASS' && output.result !== 'FAIL') return undefined;
    if (isConfigCheckerOutput(output)) return undefined;
    if (output.timedOut === true) return undefined;
    if (
      output.timedOut === undefined &&
      typeof output.details === 'string' &&
      /Command timed out after|timed out after \d+(?:\.\d+)?s\b/.test(output.details)
    ) {
      return undefined;
    }
    return output;
  }

  /** Stores PASS/FAIL outputs of checkers that really ran; SKIPs, config-validation FAILs and timeouts (inconclusive, #3186) are never cached. */
  async set(baseSha: string, envHash: string, configHash: string, outputs: readonly CheckerOutput[]): Promise<void> {
    const storable = outputs.filter(
      (o) => (o.result === 'PASS' || o.result === 'FAIL') && !isConfigCheckerOutput(o) && o.timedOut !== true,
    );
    if (storable.length === 0) return;
    const data = await this.read();
    const recordedAt = new Date(this.now()).toISOString();
    for (const output of storable) {
      data.entries[entryKey(baseSha, envHash, output.checker)] = { output, configHash, recordedAt };
    }
    await this.write(data);
  }

  private async read(): Promise<BaselineCacheFile> {
    try {
      const raw = await readFile(this.file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<BaselineCacheFile> | null;
      const entries = parsed?.entries;
      if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
        return { version: 1, entries: {} };
      }
      return { version: 1, entries };
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private async write(data: BaselineCacheFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    // Unique tmp name: lanes run concurrently. A lost concurrent write only causes a later re-run.
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmp, this.file);
  }
}
