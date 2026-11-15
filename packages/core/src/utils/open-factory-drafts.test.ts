import { describe, expect, it, vi } from 'vitest';

import { recordArgs } from '../test-support/recorders.js';

import {
  formatOpenFactoryDraftsLine,
  readOpenFactoryDrafts,
  summarizeOpenFactoryDrafts,
} from './open-factory-drafts.js';

const now = Date.parse('2026-03-10T12:00:00.000Z');
const ago = (hours: number): string => new Date(now - hours * 3_600_000 - 60_000).toISOString();

describe('summarizeOpenFactoryDrafts', () => {
  it('counts only drafts on the factory/ prefix and excludes non-draft and other-branch PRs', () => {
    const prs = [
      { branch: 'factory/1-a', draft: true, createdAt: ago(30) },
      { branch: 'factory/2-b', draft: true, createdAt: ago(5) },
      { branch: 'factory/3-c', draft: true, createdAt: ago(1) },
      { branch: 'factory/4-d', draft: false, createdAt: ago(90) },
      { branch: 'ship-it/5-e', draft: true, createdAt: ago(90) },
      { branch: 'feature/x', draft: true, createdAt: ago(90) },
      { branch: 'factoryish/6', draft: true, createdAt: ago(90) },
    ];
    expect(summarizeOpenFactoryDrafts(prs, { prefix: 'factory', now })).toEqual({ count: 3, oldestHours: 30 });
  });

  it('returns a null oldest age for no drafts', () => {
    expect(summarizeOpenFactoryDrafts([], { prefix: 'factory', now })).toEqual({ count: 0, oldestHours: null });
  });

  it('counts an unparsable createdAt with age 0 and clamps future dates', () => {
    const prs = [
      { branch: 'factory/1', draft: true, createdAt: 'nope' },
      { branch: 'factory/2', draft: true, createdAt: new Date(now + 3_600_000).toISOString() },
    ];
    expect(summarizeOpenFactoryDrafts(prs, { prefix: 'factory', now })).toEqual({ count: 2, oldestHours: 0 });
  });
});

describe('readOpenFactoryDrafts', () => {
  const row = (ref: string, draft = true) => ({ head: { ref }, draft, created_at: ago(2) });
  const reader = (list: (params: unknown) => Promise<unknown>) =>
    readOpenFactoryDrafts({
      octokit: { rest: { pulls: { list } } } as never,
      owner: 'o',
      repo: 'r',
      prefix: 'factory',
      now: () => now,
    });

  it('pages until a short page and counts both pages', async () => {
    let n = 0;
    const { calls, fn: list } = recordArgs(async (_params: unknown) => {
      n++;
      return n === 1
        ? { data: Array.from({ length: 100 }, () => row('factory/x')) }
        : { data: [row('factory/y'), row('other/z')] };
    });
    expect(await reader(list)).toEqual({ count: 101, oldestHours: 2 });
    expect(calls).toEqual([
      [{ owner: 'o', repo: 'r', state: 'open', per_page: 100, page: 1 }],
      [{ owner: 'o', repo: 'r', state: 'open', per_page: 100, page: 2 }],
    ]);
  });

  it('returns null when the first page rejects', async () => {
    expect(await reader(vi.fn().mockRejectedValue(new Error('boom')))).toBeNull();
  });

  it('returns null, not a partial count, when a later page rejects', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: Array.from({ length: 100 }, () => row('factory/x')) })
      .mockRejectedValueOnce(new Error('boom'));
    expect(await reader(list)).toBeNull();
  });

  it('returns null when every page up to the cap is full', async () => {
    const full = Array.from({ length: 100 }, () => row('factory/x'));
    const { calls, fn: list } = recordArgs(async (_params: unknown) => ({ data: full }));
    expect(await reader(list)).toBeNull();
    expect(calls).toHaveLength(50);
    expect(calls[49]).toEqual([{ owner: 'o', repo: 'r', state: 'open', per_page: 100, page: 50 }]);
  });

  it('returns null when the response is not an array', async () => {
    expect(await reader(vi.fn().mockResolvedValue({ data: null }))).toBeNull();
  });
});

describe('formatOpenFactoryDraftsLine', () => {
  it('formats unavailable, zero and populated', () => {
    expect(formatOpenFactoryDraftsLine(null)).toBe('Open factory drafts: unavailable');
    expect(formatOpenFactoryDraftsLine({ count: 0, oldestHours: null })).toBe('Open factory drafts: 0');
    expect(formatOpenFactoryDraftsLine({ count: 3, oldestHours: 30 })).toBe('Open factory drafts: 3 (oldest 30h)');
  });
});
