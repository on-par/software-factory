// packages/core/src/config/queue-config.test.ts — queue.claim_settle_ms in the factory config (#3239).

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { loadFactoryConfigForRepo } from './index.js';
import { resolveQueueClaimSettleMs } from '../queue/claim-settle.js';

describe('loadFactoryConfigForRepo queue.claim_settle_ms', () => {
  const temp = createTempDirs();
  let dir: string;

  beforeEach(async () => {
    dir = await temp.make('factory-queue-config-');
  });

  afterEach(async () => {
    await temp.cleanup();
  });

  it('queue.claim_settle_ms defaults to 3000 and accepts 0', async () => {
    expect(resolveQueueClaimSettleMs(loadFactoryConfigForRepo(join(dir, 'missing.json')))).toBe(3000);
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ merge: { auto: true } }));
    expect(resolveQueueClaimSettleMs(loadFactoryConfigForRepo(path))).toBe(3000);
    await writeFile(path, JSON.stringify({ queue: { claim_settle_ms: 0 } }));
    const config = loadFactoryConfigForRepo(path);
    expect(config.queue.claim_settle_ms).toBe(0);
    expect(resolveQueueClaimSettleMs(config)).toBe(0);
  });

  it.each([-1, '3s', 1.5])('queue.claim_settle_ms rejects %j naming the key path', async (value) => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ queue: { claim_settle_ms: value } }));
    expect(() => loadFactoryConfigForRepo(path)).toThrow(/queue\.claim_settle_ms/);
  });

  it('queue.max_review_rework_runs defaults to 2 and a configured value overrides it', async () => {
    const path = join(dir, 'config.json');
    expect(loadFactoryConfigForRepo(join(dir, 'missing.json')).queue.max_review_rework_runs).toBe(2);
    await writeFile(path, JSON.stringify({ queue: { max_review_rework_runs: 5 } }));
    expect(loadFactoryConfigForRepo(path).queue.max_review_rework_runs).toBe(5);
  });

  it.each([-1, '2', 1.5])('queue.max_review_rework_runs rejects %j naming the key path', async (value) => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ queue: { max_review_rework_runs: value } }));
    expect(() => loadFactoryConfigForRepo(path)).toThrow(/queue\.max_review_rework_runs/);
  });
});
