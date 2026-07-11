import { describe, expect, it } from 'vitest';
import { main, isPrMerged } from './cli/index.js';

describe('cli', () => {
  it('exports the main entrypoint', () => {
    expect(typeof main).toBe('function');
  });

  it('detects a merge by head branch even when it is outside the recent-closed window', async () => {
    const octokit: any = {
      rest: { pulls: { list: async ({ head }: any) =>
        head === 'on-par:ship-it/22-x'
          ? { data: [{ merged_at: '2026-01-01T00:00:00Z' }] }
          : { data: [] } } },
    };
    expect(await isPrMerged(octokit, 'on-par', 'software-factory', 'ship-it/22-x')).toBe(true);
  });

  it('returns false when the head branch has no merged PR', async () => {
    const octokit: any = { rest: { pulls: { list: async () => ({ data: [{ merged_at: null }] }) } } };
    expect(await isPrMerged(octokit, 'on-par', 'software-factory', 'ship-it/22-x')).toBe(false);
  });
});
