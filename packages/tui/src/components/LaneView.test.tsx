import type { EventKind, FactoryEvent, QueueSnapshot } from '@on-par/factory-core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { initialDashboard, lanesOf, reduceDashboard } from '../dashboard.js';
import { collapseMerged, LaneView } from './LaneView.js';

afterEach(cleanup);

function ev(type: EventKind, issue: string): FactoryEvent {
  return { ts: '2026-01-01T00:00:00.000Z', type, issue, msg: type, lane: 'prefix' };
}

function stateWith(merged: string[], running: string[]) {
  return [...merged.flatMap((n) => [ev('plan', n), ev('merged', n)]), ...running.map((n) => ev('plan', n))].reduce(
    reduceDashboard,
    initialDashboard(),
  );
}

const NOW = Date.parse('2026-01-01T00:00:05.000Z');

describe('collapseMerged', () => {
  const four = stateWith(['1706', '1707', '1708', '1709'], ['1710']);

  it('collapses more than 3 merged issues', () => {
    const r = collapseMerged(four.lanes, false);
    expect(r.collapsed).toEqual({ count: 4, first: '1706', last: '1709' });
    expect(r.rows.map((i) => i.issue)).toEqual(['1710']);
  });

  it('returns all rows when expanded', () => {
    const r = collapseMerged(four.lanes, true);
    expect(r.rows).toHaveLength(5);
    expect(r.collapsed).toBeUndefined();
  });

  it('does not collapse 3 merged', () => {
    const r = collapseMerged(stateWith(['1', '2', '3'], ['4']).lanes, false);
    expect(r.collapsed).toBeUndefined();
    expect(r.rows).toHaveLength(4);
  });
});

describe('LaneView', () => {
  const state = stateWith(['1706', '1707', '1708', '1709'], ['1710']);
  const group = lanesOf(state)[0];
  const view = (canGoBack: boolean) =>
    render(
      <LaneView group={group} state={state} selectedIndex={0} mergedExpanded={false} now={NOW} canGoBack={canGoBack} />,
    ).lastFrame() ?? '';

  it('shows the collapsed merged row without individual merged issues', () => {
    const frame = view(true);
    expect(frame).toContain('✔ 4 merged (#1706–#1709)');
    expect(frame).toContain('[m expand]');
    expect(frame).toContain('lane prefix · 4/5 merged · 1 running');
    expect(frame).not.toContain('#1707');
  });

  it('shows esc lanes only when it can go back', () => {
    expect(view(true)).toContain('esc lanes');
    expect(view(false)).not.toContain('esc lanes');
  });
});

describe('LaneView queue rows (#1744)', () => {
  const state = [ev('plan', '20'), { ...ev('escalate', '21'), msg: 'needs a human' }].reduce(
    reduceDashboard,
    initialDashboard(),
  );
  const group = lanesOf(state)[0];
  const frameFor = (queue?: QueueSnapshot) =>
    render(
      <LaneView
        group={group}
        state={state}
        selectedIndex={0}
        mergedExpanded={false}
        now={NOW}
        canGoBack
        queue={queue}
      />,
    ).lastFrame() ?? '';

  it('lists queued issues in order, once, and parked ones', () => {
    const frame = frameFor({
      entries: [
        { lane: 'prefix', issue: 30, title: 'first', status: 'queued' },
        { lane: 'prefix', issue: 20, status: 'queued' },
        { lane: 'prefix', issue: 31, status: 'queued' },
        { lane: 'prefix', issue: 32, status: 'parked' },
      ],
    });
    expect(frame.indexOf('queued (1)')).toBeGreaterThan(-1);
    expect(frame).toMatch(/queued \(1\) #30[\s\S]*queued \(2\) #31/);
    expect(frame).toMatch(/parked #32/);
    expect(frame.split('#20').length - 1).toBe(1);
  });

  it('shows the reason of an event-log parked row', () => {
    expect(frameFor()).toContain('needs a human');
  });

  it('shows one unavailable line instead of stale entries', () => {
    const frame = frameFor({ entries: [{ lane: 'prefix', issue: 30 }], error: 'boom' });
    expect(frame).toContain('queue unavailable (boom)');
    expect(frame).not.toContain('queued (');
  });

  it('renders no queue lines without a queue prop', () => {
    expect(frameFor()).not.toContain('queue');
  });
});
