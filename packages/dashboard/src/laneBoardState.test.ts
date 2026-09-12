import type { LaneLifecycleEvent, LaneLifecycleStatus } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import {
  LOG_TAIL_LIMIT,
  UNKNOWN_REPO,
  emptyLaneBoard,
  formatLogLine,
  groupLanesByRepo,
  laneStatusChip,
  parseAttachedRepos,
  readEventRepo,
  reduceLaneEvent,
  type LaneCard,
} from './laneBoardState.js';

function makeEvent(overrides: Partial<LaneLifecycleEvent> = {}): LaneLifecycleEvent {
  return {
    ts: '2026-08-19T00:00:00.000Z',
    laneId: 'lane-1',
    issueId: '593',
    phase: 'plan',
    status: 'started',
    detail: 'planning',
    worktreePath: '/tmp/lane-1',
    ...overrides,
  };
}

describe('emptyLaneBoard', () => {
  it('returns a lane-free board', () => {
    expect(emptyLaneBoard()).toEqual({ lanes: [] });
  });
});

describe('reduceLaneEvent', () => {
  it('inserts a card for an unseen laneId, with only the event phase non-pending', () => {
    const state = reduceLaneEvent(emptyLaneBoard(), makeEvent());
    expect(state.lanes).toHaveLength(1);
    const card = state.lanes[0] as LaneCard;
    expect(card.laneId).toBe('lane-1');
    expect(card.issueId).toBe('593');
    expect(card.worktreePath).toBe('/tmp/lane-1');
    expect(card.detail).toBe('planning');
    expect(card.segments).toEqual({ plan: 'active', build: 'pending', check: 'pending', ship: 'pending' });
  });

  it('defaults repo to UNKNOWN_REPO when the event carries no annotation', () => {
    const state = reduceLaneEvent(emptyLaneBoard(), makeEvent());
    expect(state.lanes[0]?.repo).toBe(UNKNOWN_REPO);
  });

  it('carries a repo annotation onto the card', () => {
    const state = reduceLaneEvent(emptyLaneBoard(), { ...makeEvent(), repo: 'on-par/software-factory' });
    expect(state.lanes[0]?.repo).toBe('on-par/software-factory');
  });

  it('keeps the existing repo when a later event for the same lane omits it', () => {
    let state = reduceLaneEvent(emptyLaneBoard(), { ...makeEvent(), repo: 'on-par/software-factory' });
    state = reduceLaneEvent(state, makeEvent({ status: 'progress' }));
    expect(state.lanes[0]?.repo).toBe('on-par/software-factory');
  });

  it('updates an existing lane in place rather than adding a second card', () => {
    let state = reduceLaneEvent(emptyLaneBoard(), makeEvent());
    state = reduceLaneEvent(state, makeEvent({ status: 'progress', detail: 'still planning' }));
    expect(state.lanes).toHaveLength(1);
    expect(state.lanes[0]?.detail).toBe('still planning');
  });

  it('preserves first-seen lane order regardless of laneId lexical order', () => {
    let state = reduceLaneEvent(emptyLaneBoard(), makeEvent({ laneId: 'lane-b' }));
    state = reduceLaneEvent(state, makeEvent({ laneId: 'lane-a' }));
    expect(state.lanes.map((lane) => lane.laneId)).toEqual(['lane-b', 'lane-a']);
  });

  it('updating one lane among several leaves the others untouched', () => {
    let state = reduceLaneEvent(emptyLaneBoard(), makeEvent({ laneId: 'lane-a' }));
    state = reduceLaneEvent(state, makeEvent({ laneId: 'lane-b' }));
    const laneBBefore = state.lanes.find((lane) => lane.laneId === 'lane-b');

    state = reduceLaneEvent(state, makeEvent({ laneId: 'lane-a', status: 'done' }));

    expect(state.lanes.find((lane) => lane.laneId === 'lane-b')).toBe(laneBBefore);
  });

  const statusToSegment: Array<[LaneLifecycleStatus, string]> = [
    ['started', 'active'],
    ['progress', 'active'],
    ['done', 'done'],
    ['failed', 'failed'],
  ];

  it.each(statusToSegment)('maps status %s to segment state %s', (status, expected) => {
    const state = reduceLaneEvent(emptyLaneBoard(), makeEvent({ status }));
    expect(state.lanes[0]?.segments.plan).toBe(expected);
  });

  it('does not back-fill an earlier phase that was never observed', () => {
    const state = reduceLaneEvent(emptyLaneBoard(), makeEvent({ phase: 'build', status: 'started' }));
    expect(state.lanes[0]?.segments.plan).toBe('pending');
    expect(state.lanes[0]?.segments.build).toBe('active');
  });

  it('caps the log tail at LOG_TAIL_LIMIT and keeps the newest entries last', () => {
    let state = emptyLaneBoard();
    for (let i = 0; i < 25; i += 1) {
      state = reduceLaneEvent(state, makeEvent({ detail: `line-${i}` }));
    }
    const log = state.lanes[0]?.log ?? [];
    expect(log).toHaveLength(LOG_TAIL_LIMIT);
    expect(log.at(-1)).toContain('line-24');
  });

  it('does not mutate the previous state', () => {
    const previous = reduceLaneEvent(emptyLaneBoard(), makeEvent());
    const previousLanesRef = previous.lanes;
    const previousCardRef = previous.lanes[0];
    const previousCardSnapshot = JSON.parse(JSON.stringify(previousCardRef));

    reduceLaneEvent(previous, makeEvent({ status: 'progress', detail: 'changed' }));

    expect(previous.lanes).toBe(previousLanesRef);
    expect(previous.lanes[0]).toBe(previousCardRef);
    expect(previous.lanes[0]).toEqual(previousCardSnapshot);
  });
});

describe('formatLogLine', () => {
  it('renders HH:MM:SS phase status — detail from an ISO ts', () => {
    expect(formatLogLine(makeEvent())).toBe('00:00:00 plan started — planning');
  });
});

describe('laneStatusChip', () => {
  it('returns the failed chip when status is failed', () => {
    const state = reduceLaneEvent(emptyLaneBoard(), makeEvent({ phase: 'check', status: 'failed' }));
    expect(laneStatusChip(state.lanes[0] as LaneCard)).toEqual({
      label: 'failed',
      className: 'bg-status-failed text-white',
    });
  });

  it('returns the shipped chip when ship is done', () => {
    const state = reduceLaneEvent(emptyLaneBoard(), makeEvent({ phase: 'ship', status: 'done' }));
    expect(laneStatusChip(state.lanes[0] as LaneCard)).toEqual({
      label: 'shipped',
      className: 'bg-status-shipped text-white',
    });
  });

  it('returns the checking chip when another phase is done', () => {
    const state = reduceLaneEvent(emptyLaneBoard(), makeEvent({ phase: 'check', status: 'done' }));
    expect(laneStatusChip(state.lanes[0] as LaneCard)).toEqual({
      label: 'check done',
      className: 'bg-status-checking text-navy-950',
    });
  });

  it('returns the building chip otherwise', () => {
    const state = reduceLaneEvent(emptyLaneBoard(), makeEvent({ phase: 'build', status: 'progress' }));
    expect(laneStatusChip(state.lanes[0] as LaneCard)).toEqual({
      label: 'build…',
      className: 'bg-status-building text-navy-950',
    });
  });
});

describe('readEventRepo', () => {
  it('reads a string repo field off an object', () => {
    expect(readEventRepo({ repo: 'on-par/software-factory' })).toBe('on-par/software-factory');
  });

  it('returns undefined when repo is absent', () => {
    expect(readEventRepo({ laneId: 'lane-1' })).toBeUndefined();
  });

  it('returns undefined when repo is present but not a string', () => {
    expect(readEventRepo({ repo: 42 })).toBeUndefined();
  });

  it.each([null, undefined, 'a string', 42, true])('returns undefined for non-object input %s', (raw) => {
    expect(readEventRepo(raw)).toBeUndefined();
  });
});

describe('groupLanesByRepo', () => {
  function cardWithRepo(repo: string, laneId = repo): LaneCard {
    const state = reduceLaneEvent(emptyLaneBoard(), { ...makeEvent({ laneId }), repo });
    return state.lanes[0] as LaneCard;
  }

  it('groups lane cards by repo', () => {
    const cardA = cardWithRepo('on-par/software-factory', 'lane-a');
    const cardB = cardWithRepo('on-par/other-repo', 'lane-b');

    const groups = groupLanesByRepo([cardA, cardB]);

    expect(groups).toEqual([
      { repo: 'on-par/software-factory', lanes: [cardA] },
      { repo: 'on-par/other-repo', lanes: [cardB] },
    ]);
  });

  it('seeds an idle group with an empty lanes array for an attached repo with no lane cards', () => {
    const groups = groupLanesByRepo([], ['on-par/software-factory']);
    expect(groups).toEqual([{ repo: 'on-par/software-factory', lanes: [] }]);
  });

  it('orders attached repos first, in config order, ahead of unlisted observed repos', () => {
    const observed = cardWithRepo('on-par/unlisted-repo');
    const groups = groupLanesByRepo([observed], ['on-par/software-factory', 'on-par/other-repo']);

    expect(groups.map((group) => group.repo)).toEqual([
      'on-par/software-factory',
      'on-par/other-repo',
      'on-par/unlisted-repo',
    ]);
  });

  it('still groups an observed repo missing from the attached list, rather than hiding it', () => {
    const observed = cardWithRepo('on-par/software-factory');
    const groups = groupLanesByRepo([observed], []);
    expect(groups).toEqual([{ repo: 'on-par/software-factory', lanes: [observed] }]);
  });

  it('returns no groups for no lanes and no attached repos', () => {
    expect(groupLanesByRepo([])).toEqual([]);
  });
});

describe('parseAttachedRepos', () => {
  it('returns an empty array for undefined', () => {
    expect(parseAttachedRepos(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseAttachedRepos('')).toEqual([]);
  });

  it('splits on commas and trims whitespace', () => {
    expect(parseAttachedRepos('on-par/software-factory, on-par/other-repo ,  ')).toEqual([
      'on-par/software-factory',
      'on-par/other-repo',
    ]);
  });

  it('de-duplicates repeated slugs while preserving first-seen order', () => {
    expect(parseAttachedRepos('a/b,c/d,a/b')).toEqual(['a/b', 'c/d']);
  });
});
