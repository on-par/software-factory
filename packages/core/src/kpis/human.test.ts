import { describe, expect, it, vi } from 'vitest';

import type { FactoryEvent } from '../types/index.js';
import {
  fetchHumanEventSources,
  hasUnresolvedPark,
  HUMAN_EVENT_TYPES,
  isHumanEvent,
  kpiBranchPrefixes,
  type PrSource,
  reconstructHumanEvents,
  reconstructKpiEvents,
} from './human.js';

function event(overrides: Partial<FactoryEvent> = {}): FactoryEvent {
  return {
    ts: '2026-07-20T00:00:00.000Z',
    type: 'issue-title',
    issue: '1',
    msg: '',
    ...overrides,
  };
}

function prSource(overrides: Partial<PrSource> = {}): PrSource {
  return {
    issue: '1',
    prNumber: 42,
    commits: [],
    approvals: [],
    mergedAt: null,
    closedAt: null,
    ...overrides,
  };
}

describe('HUMAN_EVENT_TYPES / isHumanEvent', () => {
  it('recognizes all five human-* event types', () => {
    expect(HUMAN_EVENT_TYPES.size).toBe(5);
    for (const type of [
      'human-approved',
      'human-edited',
      'human-restarted',
      'human-merged',
      'human-abandoned',
    ] as const) {
      expect(isHumanEvent(event({ type }))).toBe(true);
    }
  });

  it('is false for a non-human event', () => {
    expect(isHumanEvent(event({ type: 'merged' }))).toBe(false);
  });
});

describe('reconstructHumanEvents', () => {
  it('emits human-edited for a commit after the factory work window', () => {
    const logEvents = [
      event({ issue: '1', type: 'build', phase: 'build', ts: '2026-07-20T00:00:00.000Z' }),
      event({ issue: '1', type: 'ship', phase: 'build', ts: '2026-07-20T00:10:00.000Z' }),
    ];
    const source = prSource({
      commits: [{ sha: 'abcdef1234567', author: 'alice', ts: '2026-07-20T00:20:00.000Z' }],
    });

    const events = reconstructHumanEvents([source], logEvents);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'human-edited',
      issue: '1',
      actor: 'alice',
      msg: 'commit abcdef1 pushed after factory work ended',
    });
  });

  it('emits nothing for a commit inside the factory work window', () => {
    const logEvents = [
      event({ issue: '1', type: 'build', phase: 'build', ts: '2026-07-20T00:00:00.000Z' }),
      event({ issue: '1', type: 'ship', phase: 'build', ts: '2026-07-20T00:10:00.000Z' }),
    ];
    const source = prSource({
      commits: [{ sha: 'abcdef1234567', author: 'alice', ts: '2026-07-20T00:05:00.000Z' }],
    });

    expect(reconstructHumanEvents([source], logEvents)).toEqual([]);
  });

  it('emits nothing when there is no factory window for the issue', () => {
    const source = prSource({
      commits: [{ sha: 'abcdef1234567', author: 'alice', ts: '2026-07-20T00:20:00.000Z' }],
    });

    expect(reconstructHumanEvents([source], [])).toEqual([]);
  });

  it('emits human-merged when merged without a factory merged event', () => {
    const source = prSource({ mergedAt: '2026-07-20T01:00:00.000Z', mergedBy: 'bob' });

    const events = reconstructHumanEvents([source], []);

    expect(events).toEqual([
      {
        ts: '2026-07-20T01:00:00.000Z',
        type: 'human-merged',
        issue: '1',
        actor: 'bob',
        msg: 'PR #42 merged by a human, not the factory',
      },
    ]);
  });

  it('emits nothing for merged when the factory already logged a merged event', () => {
    const logEvents = [event({ issue: '1', type: 'merged', ts: '2026-07-20T01:00:00.000Z' })];
    const source = prSource({ mergedAt: '2026-07-20T01:00:00.000Z', mergedBy: 'bob' });

    expect(reconstructHumanEvents([source], logEvents)).toEqual([]);
  });

  it('emits human-approved for an APPROVED review', () => {
    const source = prSource({ approvals: [{ actor: 'carol', ts: '2026-07-20T00:30:00.000Z' }] });

    const events = reconstructHumanEvents([source], []);

    expect(events).toEqual([
      {
        ts: '2026-07-20T00:30:00.000Z',
        type: 'human-approved',
        issue: '1',
        actor: 'carol',
        msg: 'PR #42 review approved',
      },
    ]);
  });

  it('emits human-abandoned when the PR closed without merge', () => {
    const source = prSource({ closedAt: '2026-07-20T02:00:00.000Z' });

    const events = reconstructHumanEvents([source], []);

    expect(events).toEqual([
      {
        ts: '2026-07-20T02:00:00.000Z',
        type: 'human-abandoned',
        issue: '1',
        actor: 'unknown',
        msg: 'PR #42 closed without merge',
      },
    ]);
  });

  it('skips sources with a non-numeric issue', () => {
    const source = prSource({ issue: 'all', closedAt: '2026-07-20T02:00:00.000Z' });

    expect(reconstructHumanEvents([source], [])).toEqual([]);
  });

  it('dedupes a reconstructed event already present in the log', () => {
    const logEvents = [
      event({
        issue: '1',
        type: 'human-abandoned',
        msg: 'PR #42 closed without merge',
        ts: '2026-07-20T02:00:00.000Z',
      }),
    ];
    const source = prSource({ closedAt: '2026-07-20T02:00:00.000Z' });

    expect(reconstructHumanEvents([source], logEvents)).toEqual([]);
  });
});

describe('hasUnresolvedPark', () => {
  it('is true when a parked event has no later merged event', () => {
    const events = [event({ issue: '1', type: 'parked', ts: '2026-07-20T00:00:00.000Z' })];
    expect(hasUnresolvedPark(events, '1')).toBe(true);
  });

  it('is false when a merged event follows the parked event', () => {
    const events = [
      event({ issue: '1', type: 'parked', ts: '2026-07-20T00:00:00.000Z' }),
      event({ issue: '1', type: 'merged', ts: '2026-07-20T01:00:00.000Z' }),
    ];
    expect(hasUnresolvedPark(events, '1')).toBe(false);
  });

  it('is false when there are no park-ish events', () => {
    const events = [event({ issue: '1', type: 'issue-title' })];
    expect(hasUnresolvedPark(events, '1')).toBe(false);
  });

  it('is true for a fail event with no later merge', () => {
    const events = [event({ issue: '1', type: 'fail', ts: '2026-07-20T00:00:00.000Z' })];
    expect(hasUnresolvedPark(events, '1')).toBe(true);
  });

  it('is true for the timeout/conflict ParkReason types a single-issue ship run logs directly', () => {
    expect(hasUnresolvedPark([event({ issue: '1', type: 'timeout', ts: '2026-07-20T00:00:00.000Z' })], '1')).toBe(true);
    expect(hasUnresolvedPark([event({ issue: '1', type: 'conflict', ts: '2026-07-20T00:00:00.000Z' })], '1')).toBe(
      true,
    );
  });

  // Regression (#663): 'ci-failed' is a ParkReason a single-issue `factory ship <issue>`
  // run logs directly (see ParkReason/parkReasonFor in cli/index.ts) but was absent from
  // the old hand-maintained PARK_ISH_TYPES set, so a CI-blocked land never counted as an
  // unresolved park for human-intervention KPIs.
  it('is true for a ci-failed event with no later merge', () => {
    const events = [event({ issue: '1', type: 'ci-failed', ts: '2026-07-20T00:00:00.000Z' })];
    expect(hasUnresolvedPark(events, '1')).toBe(true);
  });
});

describe('fetchHumanEventSources', () => {
  function makeClient(overrides: Partial<Record<string, any>> = {}) {
    return {
      rest: {
        pulls: {
          list: vi.fn().mockResolvedValue({ data: [] }),
          get: vi.fn().mockResolvedValue({ data: { merged_by: { login: 'bob' } } }),
          listCommits: vi.fn().mockResolvedValue({ data: [] }),
          listReviews: vi.fn().mockResolvedValue({ data: [] }),
          ...overrides,
        },
      },
    };
  }

  it('matches the resolved prefix but not legacy ship-it/ branches', async () => {
    const client = makeClient({
      list: vi.fn().mockResolvedValue({
        data: [
          { number: 1, head: { ref: 'factory/1-a' }, state: 'open', merged_at: null, closed_at: null },
          { number: 2, head: { ref: 'ship-it/2-b' }, state: 'open', merged_at: null, closed_at: null },
          { number: 3, head: { ref: 'other/3-c' }, state: 'open', merged_at: null, closed_at: null },
        ],
      }),
    });

    const sources = await fetchHumanEventSources(client, 'owner', 'repo', new Set(['1', '2', '3']), 'factory');

    expect(sources.map((s) => s.issue).sort()).toEqual(['1']);
  });

  it('returns every factory-branch PR when the issue filter is null', async () => {
    const client = makeClient({
      list: vi.fn().mockResolvedValue({
        data: [
          { number: 1, head: { ref: 'factory/1-a' }, state: 'open', merged_at: null, closed_at: null },
          { number: 2, head: { ref: 'ship-it/2-b' }, state: 'open', merged_at: null, closed_at: null },
          { number: 3, head: { ref: 'other/3-c' }, state: 'open', merged_at: null, closed_at: null },
        ],
      }),
    });

    const sources = await fetchHumanEventSources(client, 'owner', 'repo', null, 'factory');

    expect(sources.map((s) => s.issue).sort()).toEqual(['1']);
  });

  it('filters to factory/<n>- branches within the issue set', async () => {
    const client = makeClient({
      list: vi.fn().mockResolvedValue({
        data: [
          { number: 1, head: { ref: 'factory/1-do-thing' }, state: 'open', merged_at: null, closed_at: null },
          { number: 2, head: { ref: 'factory/2-other-thing' }, state: 'open', merged_at: null, closed_at: null },
          { number: 3, head: { ref: 'not-a-factory-branch' }, state: 'open', merged_at: null, closed_at: null },
        ],
      }),
    });

    const sources = await fetchHumanEventSources(client, 'owner', 'repo', new Set(['1']));

    expect(sources).toHaveLength(1);
    expect(sources[0].issue).toBe('1');
    expect(sources[0].prNumber).toBe(1);
  });

  it('maps commit author login/name and the author date, and approvals filtered to APPROVED', async () => {
    const client = makeClient({
      list: vi.fn().mockResolvedValue({
        data: [{ number: 1, head: { ref: 'factory/1-do-thing' }, state: 'open', merged_at: null, closed_at: null }],
      }),
      listCommits: vi.fn().mockResolvedValue({
        data: [
          { sha: 'sha1', author: { login: 'alice' }, commit: { author: { date: '2026-07-20T00:00:00.000Z' } } },
          { sha: 'sha2', author: null, commit: { author: { name: 'Bob Local', date: '2026-07-20T00:01:00.000Z' } } },
        ],
      }),
      listReviews: vi.fn().mockResolvedValue({
        data: [
          { state: 'APPROVED', user: { login: 'carol' }, submitted_at: '2026-07-20T00:02:00.000Z' },
          { state: 'COMMENTED', user: { login: 'dave' }, submitted_at: '2026-07-20T00:03:00.000Z' },
        ],
      }),
    });

    const [source] = await fetchHumanEventSources(client, 'owner', 'repo', new Set(['1']));

    expect(source.commits).toEqual([
      { sha: 'sha1', author: 'alice', ts: '2026-07-20T00:00:00.000Z' },
      { sha: 'sha2', author: 'Bob Local', ts: '2026-07-20T00:01:00.000Z' },
    ]);
    expect(source.approvals).toEqual([{ actor: 'carol', ts: '2026-07-20T00:02:00.000Z' }]);
  });

  it('calls pulls.get only for merged PRs and surfaces merged_by', async () => {
    const getMock = vi.fn().mockResolvedValue({ data: { merged_by: { login: 'eve' } } });
    const client = makeClient({
      list: vi.fn().mockResolvedValue({
        data: [
          {
            number: 1,
            head: { ref: 'factory/1-do-thing' },
            state: 'closed',
            merged_at: '2026-07-20T01:00:00.000Z',
            closed_at: '2026-07-20T01:00:00.000Z',
          },
          { number: 2, head: { ref: 'factory/2-other' }, state: 'open', merged_at: null, closed_at: null },
        ],
      }),
      get: getMock,
    });

    const sources = await fetchHumanEventSources(client, 'owner', 'repo', new Set(['1', '2']));

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', pull_number: 1 });
    const merged = sources.find((s) => s.prNumber === 1)!;
    expect(merged.mergedAt).toBe('2026-07-20T01:00:00.000Z');
    expect(merged.mergedBy).toBe('eve');
    expect(merged.closedAt).toBeNull();
  });

  it('sets closedAt only when the PR closed without merge', async () => {
    const client = makeClient({
      list: vi.fn().mockResolvedValue({
        data: [
          {
            number: 1,
            head: { ref: 'factory/1-do-thing' },
            state: 'closed',
            merged_at: null,
            closed_at: '2026-07-20T01:00:00.000Z',
          },
        ],
      }),
    });

    const [source] = await fetchHumanEventSources(client, 'owner', 'repo', new Set(['1']));

    expect(source.closedAt).toBe('2026-07-20T01:00:00.000Z');
    expect(source.mergedAt).toBeNull();
  });

  it('stops paging on a short page', async () => {
    const listMock = vi.fn().mockResolvedValue({ data: [] });
    const client = makeClient({ list: listMock });

    await fetchHumanEventSources(client, 'owner', 'repo', new Set(['1']));

    expect(listMock).toHaveBeenCalledTimes(1);
  });
});

describe('kpiBranchPrefixes (#2342)', () => {
  it('returns the configured slug and factory, deduped', () => {
    expect(kpiBranchPrefixes()).toEqual(['factory']);
    expect(kpiBranchPrefixes('factory')).toEqual(['factory']);
    expect(kpiBranchPrefixes('sf')).toEqual(['sf', 'factory']);
  });
});

describe('fetchHumanEventSources prefix matching (#2342)', () => {
  const pr = (number: number, ref: string | undefined) => ({
    number,
    head: ref === undefined ? undefined : { ref },
    state: 'open',
    merged_at: null,
    closed_at: null,
  });
  const makeClient = () => ({
    rest: {
      pulls: {
        list: vi.fn().mockResolvedValue({
          data: [pr(1, 'factory/1-a'), pr(2, 'ship-it/2-b'), pr(3, 'sf/3-c'), pr(4, 'feature/4-d'), pr(5, undefined)],
        }),
        get: vi.fn().mockResolvedValue({ data: { merged_by: null } }),
        listCommits: vi.fn().mockResolvedValue({ data: [] }),
        listReviews: vi.fn().mockResolvedValue({ data: [] }),
      },
    },
  });
  const issuesFor = async (prefixes?: string | readonly string[]) =>
    (await fetchHumanEventSources(makeClient(), 'o', 'r', null, prefixes)).map((s) => s.issue).sort();

  it('fetchHumanEventSources matches factory/ and the configured prefix, not ship-it/ (#2342)', async () => {
    expect(await issuesFor('sf')).toEqual(['1', '3']);
    expect(await issuesFor()).toEqual(['1']);
    expect(await issuesFor([])).toEqual(['1']);
    expect(await issuesFor(['sf'])).toEqual(['3']);
  });
});

describe('reconstructKpiEvents (#2342)', () => {
  it('merges reconstructed human events and passes only numeric issues to the fetcher', async () => {
    const events = [event({ issue: '1' }), event({ issue: 'all' })];
    const fetchSources = vi
      .fn()
      .mockResolvedValue([prSource({ issue: '1', mergedAt: '2026-07-21T00:00:00.000Z', mergedBy: 'bob' })]);
    const res = await reconstructKpiEvents(events, fetchSources);
    expect(fetchSources).toHaveBeenCalledWith(new Set(['1']));
    expect(res.partial).toBe(false);
    expect(res.error).toBeNull();
    expect(res.sources).toHaveLength(1);
    expect(res.events.some((e) => e.type === 'human-merged')).toBe(true);
  });

  it('returns the local events and partial:true when the fetch fails', async () => {
    const events = [event()];
    const res = await reconstructKpiEvents(events, () => Promise.reject(new Error('boom')));
    expect(res).toEqual({ events, sources: [], partial: true, error: 'boom' });
  });

  it('stringifies a non-Error rejection', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const res = await reconstructKpiEvents([], () => Promise.reject('nope'));
    expect(res.partial).toBe(true);
    expect(res.error).toBe('nope');
  });
});
