import type { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';

import { MAX_LAND_SYNC_ROUNDS, probeHeadBehindBase } from './land-behind.js';

function fake(compare: (args: { basehead: string }) => Promise<{ data: unknown }>): Octokit {
  const octokit: any = { rest: { repos: { compareCommitsWithBasehead: compare } } };
  return octokit;
}

describe('probeHeadBehindBase', () => {
  it('is true when behind_by > 0 and asks for base...head', async () => {
    const seen: string[] = [];
    const octokit = fake(async (a) => {
      seen.push(a.basehead);
      return { data: { behind_by: 2 } };
    });
    expect(await probeHeadBehindBase(octokit, 'o', 'r', 'main', 'abc123')).toBe(true);
    expect(seen).toEqual(['main...abc123']);
  });

  it('is false when behind_by is 0', async () => {
    expect(
      await probeHeadBehindBase(
        fake(async () => ({ data: { behind_by: 0 } })),
        'o',
        'r',
        'main',
        'a',
      ),
    ).toBe(false);
  });

  it('is undefined when the compare call throws', async () => {
    const octokit = fake(async () => {
      throw Object.assign(new Error('nope'), { status: 404 });
    });
    expect(await probeHeadBehindBase(octokit, 'o', 'r', 'main', 'a')).toBeUndefined();
  });

  it('is undefined for a missing or non-numeric behind_by', async () => {
    expect(
      await probeHeadBehindBase(
        fake(async () => ({ data: {} })),
        'o',
        'r',
        'main',
        'a',
      ),
    ).toBeUndefined();
    expect(
      await probeHeadBehindBase(
        fake(async () => ({ data: { behind_by: '2' } })),
        'o',
        'r',
        'main',
        'a',
      ),
    ).toBeUndefined();
    expect(
      await probeHeadBehindBase(
        fake(async () => ({ data: undefined })),
        'o',
        'r',
        'main',
        'a',
      ),
    ).toBeUndefined();
  });

  it('bounds sync rounds at 3', () => {
    expect(MAX_LAND_SYNC_ROUNDS).toBe(3);
  });
});
