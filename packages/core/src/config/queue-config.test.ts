// packages/core/src/config/queue-config.test.ts — queue.claim_settle_ms in the factory config (#3239).

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadFactoryConfigForRepo } from './index.js';
import { resolveQueueClaimSettleMs } from '../queue/claim-settle.js';

describe('loadFactoryConfigForRepo queue.claim_settle_ms', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factory-queue-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
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
});
