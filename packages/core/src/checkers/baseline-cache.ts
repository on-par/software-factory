import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { CheckerOutput, Constitution } from '../types/index.js';
import { DEFAULT_BASELINE_CACHE_TTL_HOURS } from '../config/base-health.js';
import { isConfigCheckerOutput } from './index.js';
import { inconclusiveOutputCause } from './inconclusive.js';

export const BASELINE_ENV_VOLATILE_KEYS: readonly string[] = [
  'PORT',
  'FACTORY_APP_PORT',
  'FACTORY_BASE_URL',
  'SharedCompilationId',
];

export function hashBaselineEnv(env: Record<string, string> | undefined): string {
  const entries = Object.entries(env ?? {})
    .filter(([key]) => !BASELINE_ENV_VOLATILE_KEYS.includes(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

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
    private ttlHours: number = DEFAULT_BASELINE_CACHE_TTL_HOURS,
  ) {}

  async get(baseSha: string, envHash: string, configHash: string, checker: string): Promise<CheckerOutput | undefined> {
    const data = await this.read();
    const entry = data.entries[entryKey(baseSha, envHash, checker)];
    if (entry?.configHash !== configHash) return undefined;
    const recorded = Date.parse(entry.recordedAt);
    if (!Number.isFinite(recorded) || this.now() - recorded > this.ttlHours * 3_600_000) return undefined;
    const output = entry.output;
    if (typeof output !== 'object' || output === null) return undefined;
    if (output.checker !== checker) return undefined;
    if (output.result !== 'PASS' && output.result !== 'FAIL') return undefined;
    if (isConfigCheckerOutput(output)) return undefined;
    if (output.timedOut === true) return undefined;
    if (inconclusiveOutputCause(output) !== undefined) return undefined;
    if (
      output.timedOut === undefined &&
      typeof output.details === 'string' &&
      /Command timed out after|timed out after \d+(?:\.\d+)?s\b/.test(output.details)
    ) {
      return undefined;
    }
    return output;
  }

  async set(baseSha: string, envHash: string, configHash: string, outputs: readonly CheckerOutput[]): Promise<void> {
    const storable = outputs.filter(
      (o) =>
        (o.result === 'PASS' || (o.result === 'FAIL' && inconclusiveOutputCause(o) === undefined)) &&
        !isConfigCheckerOutput(o) &&
        o.timedOut !== true,
    );
    if (storable.length === 0) return;
    const data = await this.read();
    const recordedAt = new Date(this.now()).toISOString();
    for (const output of storable) {
      data.entries[entryKey(baseSha, envHash, output.checker)] = { output, configHash, recordedAt };
    }
    await this.writeLastWriterWinsSinceALostWriteOnlyCausesARerun(data);
  }

  async delete(baseSha: string, envHash: string, checker: string): Promise<boolean> {
    const data = await this.read();
    const key = entryKey(baseSha, envHash, checker);
    if (!(key in data.entries)) return false;
    delete data.entries[key];
    await this.writeLastWriterWinsSinceALostWriteOnlyCausesARerun(data);
    return true;
  }

  async clear(baseSha?: string): Promise<number> {
    const data = await this.read();
    const prefix = baseSha?.toLowerCase();
    const matches = Object.keys(data.entries).filter(
      (key) => prefix === undefined || key.slice(0, key.indexOf(':')).toLowerCase().startsWith(prefix),
    );
    if (matches.length === 0) return 0;
    for (const key of matches) delete data.entries[key];
    await this.writeLastWriterWinsSinceALostWriteOnlyCausesARerun(data);
    return matches.length;
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

  private async writeLastWriterWinsSinceALostWriteOnlyCausesARerun(data: BaselineCacheFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmpUniqueAcrossConcurrentLanes = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpUniqueAcrossConcurrentLanes, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmpUniqueAcrossConcurrentLanes, this.file);
  }
}
