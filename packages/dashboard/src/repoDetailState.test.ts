import type { RepositoryLaneLifecycleEvent } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import { emptyLaneBoard } from './laneBoardState.js';
import { repoEventsUrl, repoFromLocation, reduceRepoLaneEvent } from './repoDetailState.js';

const baseEvent: RepositoryLaneLifecycleEvent = {
  ts: '2026-08-19T00:00:00.000Z',
  laneId: 'lane-1',
  issueId: '1384',
  phase: 'plan',
  status: 'started',
  detail: 'planning',
  worktreePath: '/tmp/lane-1',
  repo: 'on-par/software-factory',
};

describe('repoFromLocation', () => {
  it('returns the slug for a leading-? query string', () => {
    expect(repoFromLocation('?repo=on-par/software-factory')).toBe('on-par/software-factory');
  });

  it('returns the slug for a leading-?-less query string', () => {
    expect(repoFromLocation('repo=a/b')).toBe('a/b');
  });

  it('returns null for an empty string', () => {
    expect(repoFromLocation('')).toBeNull();
  });

  it('returns null when repo is absent', () => {
    expect(repoFromLocation('?other=1')).toBeNull();
  });

  it('returns null for a blank repo value', () => {
    expect(repoFromLocation('?repo=%20')).toBeNull();
  });
});

describe('repoEventsUrl', () => {
  it('encodes the slash in owner/name', () => {
    expect(repoEventsUrl('on-par/software-factory')).toBe('/events?repo=on-par%2Fsoftware-factory');
  });

  it('honours an explicit baseUrl', () => {
    expect(repoEventsUrl('a/b', 'https://example.com/events')).toBe('https://example.com/events?repo=a%2Fb');
  });
});

describe('reduceRepoLaneEvent', () => {
  it('adds a lane card for a matching event', () => {
    const next = reduceRepoLaneEvent(emptyLaneBoard(), 'on-par/software-factory', baseEvent);
    expect(next.lanes).toHaveLength(1);
    expect(next.lanes[0]?.laneId).toBe('lane-1');
  });

  it('returns the identical state reference for a non-matching event', () => {
    const state = emptyLaneBoard();
    const next = reduceRepoLaneEvent(state, 'other/repo', baseEvent);
    expect(next).toBe(state);
  });

  it('bounds the log tail to 8 entries with the newest detail last', () => {
    let state = emptyLaneBoard();
    for (let i = 0; i < 12; i++) {
      state = reduceRepoLaneEvent(state, 'on-par/software-factory', {
        ...baseEvent,
        status: 'progress',
        detail: `step ${i}`,
      });
    }
    expect(state.lanes[0]?.log).toHaveLength(8);
    expect(state.lanes[0]?.log.at(-1)).toContain('step 11');
  });
});
