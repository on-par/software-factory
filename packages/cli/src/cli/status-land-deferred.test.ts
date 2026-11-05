// packages/cli/src/cli/status-land-deferred.test.ts — the Land deferred status section and JSON rows (#3957)

import { getFactoryPaths } from '@on-par/factory-core';
import { landDeferredFile, upsertLandDeferred, type LandDeferredRecord } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { statusJsonSchema } from './json-contract.js';
import { buildStatusJson } from './status-json.js';
import { formatLandDeferredSection, readLandDeferredStatus } from './status-land-deferred.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const rec = (issue: number, over: Partial<LandDeferredRecord> = {}): LandDeferredRecord => ({
  issue,
  prNumber: issue + 1000,
  branch: `factory/${issue}-x`,
  firstDeferredAt: Date.parse('2026-01-01T00:00:00Z') + issue,
  deferrals: 2,
  nextRetryAt: Date.parse('2026-01-01T00:07:00Z'),
  lastMessage: 'base kept moving',
  ...over,
});

describe('status land-deferred (#3957)', () => {
  it('status lists land-deferred PRs with their retry count', async () => {
    const dir = dirs.makeSync('status-land-deferred-');
    const paths = getFactoryPaths(dir);
    await upsertLandDeferred(landDeferredFile(paths), rec(2));
    await upsertLandDeferred(landDeferredFile(paths), rec(1, { deferrals: 1 }));
    const status = await readLandDeferredStatus(paths, () => ({ merge: { maxLandDeferrals: 5 } }) as any);
    expect(formatLandDeferredSection(status)).toEqual([
      '  #1 PR #1001 deferred 1/5, next retry 2026-01-01T00:07:00.000Z',
      '  #2 PR #1002 deferred 2/5, next retry 2026-01-01T00:07:00.000Z',
    ]);
  });

  it('prints (none) when nothing is deferred and falls back to the default cap on an unreadable config', async () => {
    const dir = dirs.makeSync('status-land-deferred-empty-');
    const status = await readLandDeferredStatus(getFactoryPaths(dir), () => {
      throw new Error('bad config');
    });
    expect(status).toEqual({ records: [], maxDeferrals: 3 });
    expect(formatLandDeferredSection(status)).toEqual(['  (none)']);
  });

  it('status --json carries landDeferred rows', () => {
    const base = {
      repo: 'o/r',
      product: null,
      stop: false,
      stopInfo: null,
      breakers: [],
      active: [],
      update: null,
      openFactoryDrafts: null,
      disk: null,
      now: 0,
    };
    const out = buildStatusJson({ ...base, landDeferred: [rec(1)], maxLandDeferrals: 4 });
    expect(out.landDeferred).toEqual([
      {
        issue: 1,
        prNumber: 1001,
        branch: 'factory/1-x',
        deferrals: 2,
        maxDeferrals: 4,
        firstDeferredAt: '2026-01-01T00:00:00.001Z',
        nextRetryAt: '2026-01-01T00:07:00.000Z',
      },
    ]);
    expect(statusJsonSchema.parse(out)).toEqual(out);
    expect(buildStatusJson(base).landDeferred).toEqual([]);
  });
});
