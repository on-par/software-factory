// packages/core/src/queue/clock-skew.test.ts — clock skew measurement against GitHub's Date header (#3149).

import { describe, expect, it, vi } from 'vitest';

import { defaultFactoryConfig } from '@on-par/factory-config';

import type { FactoryConfig } from '../config/index.js';
import {
  createClockSkewCache,
  isClockSkewExcessive,
  measureClockSkew,
  measureGithubClockSkew,
  parseHttpDateMs,
  resolveQueueMaxClockSkewMs,
} from './clock-skew.js';

const SERVER_DATE = 'Sun, 06 Nov 1994 08:49:37 GMT';
const SERVER_MS = Date.parse(SERVER_DATE);

describe('parseHttpDateMs', () => {
  it('parses an IMF-fixdate', () => {
    expect(parseHttpDateMs(SERVER_DATE)).toBe(SERVER_MS);
  });
  it('returns null for missing, empty or garbage headers', () => {
    expect(parseHttpDateMs(undefined)).toBeNull();
    expect(parseHttpDateMs('')).toBeNull();
    expect(parseHttpDateMs('not a date')).toBeNull();
  });
});

describe('measureClockSkew', () => {
  it('is positive when the local clock is fast and negative when slow', async () => {
    const serverDate = async () => SERVER_DATE;
    expect(await measureClockSkew({ serverDate, now: () => SERVER_MS + 5000 })).toBe(5000);
    expect(await measureClockSkew({ serverDate, now: () => SERVER_MS - 5000 })).toBe(-5000);
  });

  it('reuses a cached measurement inside the TTL and re-measures after it', async () => {
    const serverDate = vi.fn(async () => SERVER_DATE);
    const cache = createClockSkewCache(600_000);
    let nowMs = SERVER_MS + 1000;
    const now = () => nowMs;
    expect(await measureClockSkew({ serverDate, now, cache })).toBe(1000);
    nowMs += 599_000;
    await measureClockSkew({ serverDate, now, cache });
    expect(serverDate).toHaveBeenCalledTimes(1);
    nowMs += 1000;
    await measureClockSkew({ serverDate, now, cache });
    expect(serverDate).toHaveBeenCalledTimes(2);
  });

  it('returns null and caches nothing when serverDate throws or the header is unparsable', async () => {
    const cache = createClockSkewCache();
    expect(await measureClockSkew({ serverDate: async () => Promise.reject(new Error('503')), cache })).toBeNull();
    expect(await measureClockSkew({ serverDate: async () => 'garbage', cache })).toBeNull();
    expect(await measureClockSkew({ serverDate: async () => undefined, cache })).toBeNull();
    expect(cache.get(Date.now())).toBeUndefined();
  });

  it('clear() drops the cached value', async () => {
    const cache = createClockSkewCache();
    await measureClockSkew({ serverDate: async () => SERVER_DATE, now: () => SERVER_MS, cache });
    cache.clear();
    expect(cache.get(SERVER_MS)).toBeUndefined();
  });
});

describe('isClockSkewExcessive', () => {
  it('is strict above the threshold in either direction and false for null', () => {
    expect(isClockSkewExcessive(60_000, 60_000)).toBe(false);
    expect(isClockSkewExcessive(60_001, 60_000)).toBe(true);
    expect(isClockSkewExcessive(-60_001, 60_000)).toBe(true);
    expect(isClockSkewExcessive(-2000, 60_000)).toBe(false);
    expect(isClockSkewExcessive(null, 0)).toBe(false);
  });
});

describe('measureGithubClockSkew', () => {
  it('reads the Date header of rest.rateLimit.get', async () => {
    const get = vi.fn(async () => ({ headers: { date: SERVER_DATE } }));
    expect(await measureGithubClockSkew({ rest: { rateLimit: { get } } }, { now: () => SERVER_MS + 3000 })).toBe(3000);
  });
  it('returns null when the header is absent or the call fails', async () => {
    expect(await measureGithubClockSkew({ rest: { rateLimit: { get: async () => ({}) } } })).toBeNull();
    const failing = { rest: { rateLimit: { get: async () => Promise.reject(new Error('boom')) } } };
    expect(await measureGithubClockSkew(failing)).toBeNull();
  });
});

describe('resolveQueueMaxClockSkewMs', () => {
  it('defaults to 60s and honours an override', () => {
    const base: FactoryConfig = structuredClone(defaultFactoryConfig) as FactoryConfig;
    expect(resolveQueueMaxClockSkewMs(base)).toBe(60_000);
    expect(resolveQueueMaxClockSkewMs({ ...base, queue: { ...base.queue, maxClockSkewMs: 5000 } })).toBe(5000);
  });
});
