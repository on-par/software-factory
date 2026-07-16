import { describe, expect, it } from 'vitest';
import type { FactoryEvent } from '@on-par/factory-core';
import { PHASES, initialState, isFailoverEvent, reduceEvent } from './state.js';

function ev(type: string, msg: string, ts = new Date().toISOString(), issue = '192'): FactoryEvent {
  return { ts, type, issue, msg };
}

describe('initialState', () => {
  it('starts with all phases pending and an empty feed', () => {
    const state = initialState();
    expect(state.phaseStatus).toEqual({ PLAN: 'pending', BUILD: 'pending', CHECK: 'pending', SHIP: 'pending' });
    expect(state.done).toBe(false);
    expect(state.feed).toEqual([]);
    expect(state.activePhase).toBeUndefined();
  });
});

describe('reduceEvent', () => {
  it('drives a full run through PLAN -> BUILD -> CHECK -> SHIP -> ready', () => {
    let state = initialState();

    state = reduceEvent(state, ev('worktree', 'Creating worktree'));
    expect(state.phaseStatus).toEqual({ PLAN: 'pending', BUILD: 'pending', CHECK: 'pending', SHIP: 'pending' });

    const planStart = ev('plan', 'Starting plan phase', '2026-01-01T00:00:00.000Z');
    state = reduceEvent(state, planStart);
    expect(state.activePhase).toBe('PLAN');
    expect(state.phaseStatus).toEqual({ PLAN: 'active', BUILD: 'pending', CHECK: 'pending', SHIP: 'pending' });
    expect(state.phaseStartedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.issue).toBe('192');

    state = reduceEvent(state, ev('router', 'Trying claude-sonnet for plan (attempt 1)'));
    expect(state.model).toBe('claude-sonnet');

    // Plan completes with a different timestamp — since PLAN is still active, phaseStartedAt must not reset.
    state = reduceEvent(
      state,
      ev('plan', 'Plan complete with model claude-sonnet, route: claude', '2026-01-01T00:05:00.000Z'),
    );
    expect(state.phaseStartedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.model).toBe('claude-sonnet');
    expect(state.route).toBe('claude');

    const buildStart = ev('build', 'Starting build phase (route: codex)', '2026-01-01T00:06:00.000Z');
    state = reduceEvent(state, buildStart);
    expect(state.activePhase).toBe('BUILD');
    expect(state.phaseStatus).toEqual({ PLAN: 'done', BUILD: 'active', CHECK: 'pending', SHIP: 'pending' });
    expect(state.phaseStartedAt).toBe('2026-01-01T00:06:00.000Z');
    expect(state.route).toBe('codex');

    state = reduceEvent(state, ev('build', 'Build complete with model gpt-5-codex'));
    expect(state.model).toBe('gpt-5-codex');

    const checkStart = ev('check', 'Running checkers', '2026-01-01T00:10:00.000Z');
    state = reduceEvent(state, checkStart);
    expect(state.activePhase).toBe('CHECK');
    expect(state.phaseStatus).toEqual({ PLAN: 'done', BUILD: 'done', CHECK: 'active', SHIP: 'pending' });
    expect(state.phaseStartedAt).toBe('2026-01-01T00:10:00.000Z');

    // Rework round: CHECK remains active, timer must not reset.
    state = reduceEvent(
      state,
      ev('rework', '2 failures — sending back to worker (round 1)', '2026-01-01T00:12:00.000Z'),
    );
    expect(state.activePhase).toBe('CHECK');
    expect(state.phaseStartedAt).toBe('2026-01-01T00:10:00.000Z');

    state = reduceEvent(state, ev('check', 'All checkers passed'));
    expect(state.activePhase).toBe('CHECK');

    const shipStart = ev('ship', 'Watching CI for PR #192', '2026-01-01T00:20:00.000Z');
    state = reduceEvent(state, shipStart);
    expect(state.activePhase).toBe('SHIP');
    expect(state.phaseStatus).toEqual({ PLAN: 'done', BUILD: 'done', CHECK: 'done', SHIP: 'active' });
    expect(state.phaseStartedAt).toBe('2026-01-01T00:20:00.000Z');
    expect(state.done).toBe(false);

    state = reduceEvent(state, ev('ready', 'PR #192 ready for review'));
    expect(state.done).toBe(true);
    expect(state.activePhase).toBeUndefined();
    expect(state.phaseStatus).toEqual({ PLAN: 'done', BUILD: 'done', CHECK: 'done', SHIP: 'done' });

    // A queue can drain straight into the next issue on the same events file —
    // once a new phase event arrives, the header must stop reporting "ready".
    state = reduceEvent(state, ev('plan', 'Starting plan phase', '2026-01-01T01:00:00.000Z', '193'));
    expect(state.done).toBe(false);
    expect(state.activePhase).toBe('PLAN');
  });

  it('caps the feed at the last 10 events', () => {
    let state = initialState();
    for (let i = 0; i < 15; i++) {
      state = reduceEvent(state, ev('plan', `event ${i}`));
    }
    expect(state.feed).toHaveLength(10);
    expect(state.feed[0].msg).toBe('event 5');
    expect(state.feed[9].msg).toBe('event 14');
  });

  it('leaves model/route unchanged when a message does not match extraction patterns', () => {
    let state = initialState();
    state = reduceEvent(state, ev('plan', 'Starting plan phase'));
    state = reduceEvent(state, ev('router', 'Trying claude-sonnet for plan (attempt 1)'));
    expect(state.model).toBe('claude-sonnet');

    state = reduceEvent(state, ev('plan', 'Archived existing spec before planning: /tmp/foo'));
    expect(state.model).toBe('claude-sonnet');
    expect(state.route).toBeUndefined();
  });

  it('records the PHASES order as PLAN, BUILD, CHECK, SHIP', () => {
    expect(PHASES).toEqual(['PLAN', 'BUILD', 'CHECK', 'SHIP']);
  });
});

describe('isFailoverEvent', () => {
  it('flags router failover messages', () => {
    expect(isFailoverEvent(ev('router', 'claude-sonnet failed (rate_limit) on plan'))).toBe(true);
    expect(isFailoverEvent(ev('router', 'Rate limited — cooldown 5000ms before retry'))).toBe(true);
    expect(isFailoverEvent(ev('router', 'Usage cap hit on claude-sonnet — failing over to next model'))).toBe(true);
    expect(isFailoverEvent(ev('router', 'gpt-5-codex timed out on build — failing over'))).toBe(true);
  });

  it('does not flag a plain router "Trying" message', () => {
    expect(isFailoverEvent(ev('router', 'Trying claude-sonnet for plan (attempt 1)'))).toBe(false);
  });

  it('flags warn/escalate/fail events regardless of message', () => {
    expect(isFailoverEvent(ev('warn', 'codex unavailable — falling back to claude'))).toBe(true);
    expect(isFailoverEvent(ev('escalate', 'plan escalated'))).toBe(true);
    expect(isFailoverEvent(ev('fail', 'unrecoverable error'))).toBe(true);
  });

  it('does not flag normal phase events', () => {
    expect(isFailoverEvent(ev('plan', 'Starting plan phase'))).toBe(false);
    expect(isFailoverEvent(ev('ship', 'CI green for PR #192'))).toBe(false);
  });
});
