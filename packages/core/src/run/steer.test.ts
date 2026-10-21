import { describe, expect, it } from 'vitest';

import type { IssueRunState } from '../types/index.js';
import { appendSteerEvent, listSteerEvents, parseSteerEvent, STEER_SOURCES, SteerEventError } from './steer.js';

const state: IssueRunState = {
  issue: 3400,
  lane: 'feature',
  status: 'building',
  branch: 'factory/3400-x',
  worktree: '/w',
  specPath: '/s.md',
  model: 'm',
  route: 'claude',
  attempts: 1,
  startedAt: '2026-10-20T11:00:00.000Z',
  updatedAt: '2026-10-20T11:00:00.000Z',
};

const event = {
  ts: '2026-10-20T12:00:00.000Z',
  actor: 'octocat',
  source: 'cli',
  phase: 'build',
  summary: 'told it to use the existing helper',
  unblocked: true,
};

describe('appendSteerEvent', () => {
  it('appends a valid cli event and lists exactly that event with all fields', () => {
    const next = appendSteerEvent(state, event);
    expect(listSteerEvents(next)).toEqual([event]);
    expect(listSteerEvents(next)).toHaveLength(1);
    const { unblocked: _unblocked, ...without } = event;
    const [stored] = listSteerEvents(appendSteerEvent(state, without));
    expect(stored).toEqual(without);
    expect('unblocked' in stored!).toBe(false);
  });

  it.each(['slack', 'CLI', '', 42])(
    'rejects an unknown source with an error naming it and leaves the state unchanged: %j',
    (source) => {
      const withOne = appendSteerEvent(state, event);
      for (const target of [state, withOne]) {
        const clone = structuredClone(target);
        const before = listSteerEvents(target);
        expect(() => appendSteerEvent(target, { ...event, source })).toThrow(SteerEventError);
        expect(() => appendSteerEvent(target, { ...event, source })).toThrow(JSON.stringify(source));
        expect(target).toEqual(clone);
        expect(listSteerEvents(target)).toBe(before);
      }
    },
  );

  it('rejects a missing source', () => {
    const { source: _source, ...rest } = event;
    expect(() => appendSteerEvent(state, rest)).toThrow(/invalid steer source undefined/);
  });

  it('keeps insertion order on a third append and leaves the first two events unchanged', () => {
    const e1 = { ...event, source: 'cli', summary: 'one' };
    const e2 = { ...event, source: 'bot', summary: 'two' };
    const e3 = { ...event, source: 'github-comment', summary: 'three' };
    const frozenState = structuredClone(state);
    const s2 = appendSteerEvent(appendSteerEvent(frozenState, e1), e2);
    const [first, second] = listSteerEvents(s2);
    const clones = [structuredClone(first), structuredClone(second)];
    const s3 = appendSteerEvent(s2, e3);
    expect(listSteerEvents(s3).map((e) => e.summary)).toEqual(['one', 'two', 'three']);
    expect(listSteerEvents(s3)[0]).toBe(first);
    expect(listSteerEvents(s3)[1]).toBe(second);
    expect([first, second]).toEqual(clones);
    expect(listSteerEvents(s2)).toHaveLength(2);
    expect(listSteerEvents(s3).every((e) => Object.isFrozen(e))).toBe(true);
    expect(Object.isFrozen(listSteerEvents(s3))).toBe(true);
    expect(frozenState).toEqual(state);
    expect(frozenState.steers).toBeUndefined();
  });
});

describe('parseSteerEvent', () => {
  it.each([
    ['invalid ts', { ...event, ts: 'yesterday' }],
    ['empty actor', { ...event, actor: '  ' }],
    ['empty summary', { ...event, summary: '' }],
    ['unknown phase', { ...event, phase: 'deploy' }],
    ['unknown extra key', { ...event, extra: 1 }],
    ['null', null],
    ['array', []],
  ])('rejects %s', (_name, input) => {
    expect(() => parseSteerEvent(input)).toThrow(SteerEventError);
  });

  it.each(STEER_SOURCES)('accepts source %s', (source) => {
    expect(parseSteerEvent({ ...event, source }).source).toBe(source);
  });
});
