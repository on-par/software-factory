import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { QueueSnapshot } from '@on-par/factory-core';
import { initialDashboard, reduceDashboard, type LaneState } from '../dashboard.js';
import { QueueTab } from './QueueTab.js';

afterEach(cleanup);

function laneFor(issue: string, events: Array<{ type: string; msg: string }>): LaneState {
  let state = initialDashboard();
  for (const e of events) {
    state = reduceDashboard(state, { ts: '2026-01-01T00:00:00.000Z', type: e.type, issue, msg: e.msg });
  }
  return state.lanes[0];
}

describe('QueueTab', () => {
  it('renders "queue is empty" for an empty snapshot', () => {
    const { lastFrame } = render(<QueueTab snapshot={{ entries: [] }} lanes={[]} />);
    expect(lastFrame()).toContain('queue is empty');
  });

  it('renders rows with position, lane, issue number, and status from a matching lane', () => {
    const lane = laneFor('61', [{ type: 'plan', msg: 'Starting plan phase' }]);
    const snapshot: QueueSnapshot = { entries: [{ lane: 'app', issue: 61 }] };
    const { lastFrame } = render(<QueueTab snapshot={snapshot} lanes={[lane]} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1.');
    expect(frame).toContain('app');
    expect(frame).toContain('#61');
    expect(frame).toContain('running');
  });

  it('shows the lane title when present', () => {
    const lane: LaneState = {
      ...laneFor('61', [{ type: 'plan', msg: 'Starting plan phase' }]),
      title: 'Fix the flaky test',
    };
    const snapshot: QueueSnapshot = { entries: [{ lane: 'app', issue: 61 }] };
    const { lastFrame } = render(<QueueTab snapshot={snapshot} lanes={[lane]} />);
    expect(lastFrame()).toContain('Fix the flaky test');
  });

  it('falls back to "queued" status when no lane matches the entry', () => {
    const snapshot: QueueSnapshot = { entries: [{ lane: 'app', issue: 99 }] };
    const { lastFrame } = render(<QueueTab snapshot={snapshot} lanes={[]} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('#99');
    expect(frame).toContain('queued');
  });

  it('shows a proposed-count footer when proposedCount > 0', () => {
    const snapshot: QueueSnapshot = { entries: [{ lane: 'app', issue: 61 }], proposedCount: 3 };
    const { lastFrame } = render(<QueueTab snapshot={snapshot} lanes={[]} />);
    expect(lastFrame()).toContain('3 proposed issue(s) awaiting: factory triage accept');
  });

  it('omits the footer when proposedCount is 0 or absent', () => {
    const zero: QueueSnapshot = { entries: [{ lane: 'app', issue: 61 }], proposedCount: 0 };
    expect(render(<QueueTab snapshot={zero} lanes={[]} />).lastFrame()).not.toContain('proposed issue');

    const absent: QueueSnapshot = { entries: [{ lane: 'app', issue: 61 }] };
    expect(render(<QueueTab snapshot={absent} lanes={[]} />).lastFrame()).not.toContain('proposed issue');
  });
});
