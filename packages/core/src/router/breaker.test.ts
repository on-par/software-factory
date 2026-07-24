import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { gateBuildOnBreaker, ProviderBreaker } from './breaker.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs.clear();
});

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'breaker-test-'));
  tempDirs.add(dir);
  return join(dir, 'breaker.json');
}

describe('ProviderBreaker', () => {
  it('reports open with remainingMs within the cooldown window', async () => {
    const file = await tmpFile();
    let t = 1_000_000;
    const breaker = new ProviderBreaker(file, () => t);

    await breaker.open('openai', 'usage_cap', 1_800_000);
    t += 100_000;

    const status = await breaker.status('openai');
    expect(status.open).toBe(true);
    if (status.open) {
      expect(status.entry.reason).toBe('usage_cap');
      expect(status.remainingMs).toBe(1_800_000 - 100_000);
    }
  });

  it('closes once after cooldown expiry, prunes the file, and reports closed on a second call', async () => {
    const file = await tmpFile();
    let t = 0;
    const breaker = new ProviderBreaker(file, () => t);

    await breaker.open('openai', 'usage_cap', 1_800_000);
    t = 1_800_001;

    const firstStatus = await breaker.status('openai');
    expect(firstStatus).toEqual({
      open: false,
      justClosed: { reason: 'usage_cap', openedAt: expect.any(String), cooldownMs: 1_800_000 },
    });

    const secondStatus = await breaker.status('openai');
    expect(secondStatus).toEqual({ open: false });
  });

  it('refreshes openedAt when re-opening an already-open provider', async () => {
    const file = await tmpFile();
    let t = 0;
    const breaker = new ProviderBreaker(file, () => t);

    await breaker.open('openai', 'usage_cap', 1_800_000);
    t = 500_000;
    await breaker.open('openai', 'usage_cap', 1_800_000);

    const status = await breaker.status('openai');
    expect(status.open).toBe(true);
    if (status.open) expect(status.remainingMs).toBe(1_800_000);
  });

  it('treats a missing file as closed', async () => {
    const file = await tmpFile();
    const breaker = new ProviderBreaker(file);
    expect(await breaker.status('openai')).toEqual({ open: false });
    expect(await breaker.list()).toEqual([]);
  });

  it('treats a corrupt (non-JSON) file as closed', async () => {
    const file = await tmpFile();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, 'not json{{{');
    const breaker = new ProviderBreaker(file);
    expect(await breaker.status('openai')).toEqual({ open: false });
    expect(await breaker.list()).toEqual([]);
  });

  it('list() excludes expired entries and never rewrites the file', async () => {
    const file = await tmpFile();
    let t = 0;
    const breaker = new ProviderBreaker(file, () => t);
    await breaker.open('openai', 'usage_cap', 1_800_000);
    t = 900_000;

    const before = await readFile(file, 'utf-8');
    const list = await breaker.list();
    expect(list).toEqual([
      { provider: 'openai', reason: 'usage_cap', openedAt: expect.any(String), remainingMs: 900_000 },
    ]);
    const after = await readFile(file, 'utf-8');
    expect(after).toBe(before);

    t = 1_800_001;
    const expiredList = await breaker.list();
    expect(expiredList).toEqual([]);
    const stillAfter = await readFile(file, 'utf-8');
    expect(stillAfter).toBe(before);
  });
});

describe('gateBuildOnBreaker', () => {
  it('blocks codex and logs provider_breaker_skip when a provider is open', async () => {
    const file = await tmpFile();
    let t = 0;
    const breaker = new ProviderBreaker(file, () => t);
    await breaker.open('openai', 'usage_cap', 1_800_000);
    t = 100_000;

    const logs: Array<[string, string]> = [];
    const result = await gateBuildOnBreaker({
      breaker,
      providers: ['openai'],
      log: (type, msg) => logs.push([type, msg]),
    });

    expect(result.codexBlocked).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toBe('provider_breaker_skip');
    expect(logs[0][1]).toMatch(/breaker open for openai \(usage_cap\).*29m remaining/);
  });

  it('logs provider_breaker_close and does not block when the breaker just expired', async () => {
    const file = await tmpFile();
    let t = 0;
    const breaker = new ProviderBreaker(file, () => t);
    await breaker.open('openai', 'usage_cap', 1_800_000);
    t = 1_800_001;

    const logs: Array<[string, string]> = [];
    const result = await gateBuildOnBreaker({
      breaker,
      providers: ['openai'],
      log: (type, msg) => logs.push([type, msg]),
    });

    expect(result.codexBlocked).toBe(false);
    expect(logs).toEqual([
      ['provider_breaker_close', 'breaker closed for openai after cooldown — codex workers eligible again'],
    ]);
  });

  it('logs nothing and does not block when the breaker is closed/absent', async () => {
    const file = await tmpFile();
    const breaker = new ProviderBreaker(file);

    const logs: Array<[string, string]> = [];
    const result = await gateBuildOnBreaker({
      breaker,
      providers: ['openai'],
      log: (type, msg) => logs.push([type, msg]),
    });

    expect(result.codexBlocked).toBe(false);
    expect(logs).toEqual([]);
  });
});
