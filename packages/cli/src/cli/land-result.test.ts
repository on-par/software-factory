import { describe, expect, it } from 'vitest';

import { landResultJsonSchema } from './land-result-contract.js';
import { buildLandResultJson, formatLandResultLine, readLandSnapshot, type LandResultKind } from './land-result.js';

const octokitWith = (graphql: (query: string, vars: unknown) => Promise<unknown>): any => ({ graphql });

const rollup = (nodes: unknown[], mergeable: unknown = 'MERGEABLE') => ({
  repository: {
    pullRequest: {
      headRefOid: 'abc',
      mergeable,
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] },
    },
  },
});

describe('readLandSnapshot', () => {
  it('collects pending and failed check names from the status rollup', async () => {
    const octokit = octokitWith(async () =>
      rollup([
        { __typename: 'CheckRun', name: 'zeta', status: 'IN_PROGRESS', conclusion: null },
        { __typename: 'CheckRun', name: 'alpha', status: 'QUEUED', conclusion: null },
        { __typename: 'CheckRun', name: 'alpha', status: 'QUEUED', conclusion: null },
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING' },
        { __typename: 'StatusContext', context: 'ci/bad', state: 'ERROR' },
        { __typename: 'StatusContext', context: 'ci/ok', state: 'SUCCESS' },
      ]),
    );
    expect(await readLandSnapshot(octokit, 'o', 'r', 7)).toEqual({
      headSha: 'abc',
      mergeable: 'MERGEABLE',
      pending: ['alpha', 'ci/legacy', 'zeta'],
      failed: ['build', 'ci/bad'],
    });
  });

  it('returns an unknown snapshot when the read fails', async () => {
    const unknown = { headSha: null, mergeable: 'UNKNOWN', pending: [], failed: [] };
    expect(
      await readLandSnapshot(
        octokitWith(async () => {
          throw new Error('boom');
        }),
        'o',
        'r',
        7,
      ),
    ).toEqual(unknown);
    expect(
      await readLandSnapshot(
        octokitWith(async () => ({ repository: { pullRequest: null } })),
        'o',
        'r',
        7,
      ),
    ).toEqual(unknown);
  });

  it('normalises an unexpected mergeable value to UNKNOWN', async () => {
    const snap = await readLandSnapshot(
      octokitWith(async () => rollup([], 'WEIRD')),
      'o',
      'r',
      7,
    );
    expect(snap.mergeable).toBe('UNKNOWN');
    const bare = await readLandSnapshot(
      octokitWith(async () => ({ repository: { pullRequest: { headRefOid: 'abc', mergeable: null } } })),
      'o',
      'r',
      7,
    );
    expect(bare).toEqual({ headSha: 'abc', mergeable: 'UNKNOWN', pending: [], failed: [] });
  });
});

describe('buildLandResultJson', () => {
  const snapshot = { headSha: 'abc', mergeable: 'MERGEABLE' as const, pending: ['ci'], failed: ['build'] };

  it('uses failed instead of pending for checks_failed', () => {
    const json = buildLandResultJson('checks_failed', 7, snapshot);
    expect(json).toEqual({
      schemaVersion: 1,
      result: 'checks_failed',
      pr: 7,
      headSha: 'abc',
      failed: ['build'],
      mergeable: 'MERGEABLE',
    });
    expect('pending' in json).toBe(false);
  });

  it('builds a schema-valid object for every result kind', () => {
    const kinds: LandResultKind[] = ['merged', 'checks_pending', 'checks_failed', 'conflicting', 'closed'];
    for (const kind of kinds) {
      const json = buildLandResultJson(kind, 7, snapshot);
      expect(landResultJsonSchema.parse(JSON.parse(formatLandResultLine(json)))).toEqual(json);
    }
    expect(buildLandResultJson('merged', 7, snapshot)).toMatchObject({ pending: [] });
    expect(buildLandResultJson('closed', 7, snapshot)).toMatchObject({ pending: [] });
    expect(buildLandResultJson('checks_pending', 7, snapshot)).toMatchObject({ pending: ['ci'] });
  });
});

describe('landResultJsonSchema', () => {
  it('rejects a checks_failed object that carries pending and no failed', () => {
    const base = { schemaVersion: 1, pr: 7, headSha: null, mergeable: 'UNKNOWN' };
    expect(landResultJsonSchema.safeParse({ ...base, result: 'checks_failed', pending: [] }).success).toBe(false);
    expect(landResultJsonSchema.safeParse({ ...base, result: 'checks_failed', failed: ['ci'] }).success).toBe(true);
  });
});
