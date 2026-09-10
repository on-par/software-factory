import type { EventKind, QueueSnapshot } from '@on-par/factory-core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { initialDashboard, type LaneState, reduceDashboard } from '../dashboard.js';
import { QueueTab } from './QueueTab.js';

afterEach(cleanup);

function laneFor(issue: string, events: Array<{ type: EventKind; msg: string }>): LaneState {
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

  it('names the queue source in a heading when given one (#1362)', () => {
    const { lastFrame } = render(<QueueTab snapshot={{ entries: [] }} lanes={[]} source="GitHub" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('queue: GitHub');
    expect(frame).toContain('queue is empty');
    expect(render(<QueueTab snapshot={{ entries: [] }} lanes={[]} />).lastFrame()).not.toContain('queue:');
  });

  it('renders status, claimant, and title carried on the snapshot entry when no lane matches (#1362)', () => {
    const snapshot: QueueSnapshot = {
      entries: [
        { lane: 'ops', issue: 7, title: 'Rotate the keys', status: 'in-progress', claimant: 'mini-123' },
        { lane: 'ops', issue: 8, title: 'Parked one', status: 'parked' },
        { lane: 'ops', issue: 9, title: 'Plain queued', status: 'queued' },
      ],
    };
    const frame = render(<QueueTab snapshot={snapshot} lanes={[]} source="GitHub" />).lastFrame() ?? '';
    expect(frame).toContain('#7');
    expect(frame).toContain('in-progress (mini-123)');
    expect(frame).toContain('Rotate the keys');
    expect(frame).toContain('#8');
    expect(frame).toContain('parked');
    expect(frame).toContain('#9');
    expect(frame).toContain('queued');
    expect(frame).toContain('Plain queued');
  });

  it('prefers a live lane over the snapshot entry for status and title', () => {
    const lane: LaneState = {
      ...laneFor('61', [{ type: 'plan', msg: 'Starting plan phase' }]),
      title: 'Title from the event log',
    };
    const snapshot: QueueSnapshot = {
      entries: [{ lane: 'app', issue: 61, title: 'Title from GitHub', status: 'queued', claimant: 'ignored' }],
    };
    const frame = render(<QueueTab snapshot={snapshot} lanes={[lane]} />).lastFrame() ?? '';
    expect(frame).toContain('running');
    expect(frame).toContain('Title from the event log');
    expect(frame).not.toContain('Title from GitHub');
    expect(frame).not.toContain('ignored');
  });

  it('shows the snapshot error instead of "queue is empty", and above any kept entries', () => {
    const empty: QueueSnapshot = { entries: [], error: 'no GitHub token — run `gh auth login`' };
    const emptyFrame = render(<QueueTab snapshot={empty} lanes={[]} source="GitHub" />).lastFrame() ?? '';
    expect(emptyFrame).toContain('(no GitHub token — run `gh auth login`)');
    expect(emptyFrame).not.toContain('queue is empty');

    const kept: QueueSnapshot = {
      entries: [{ lane: 'app', issue: 61 }],
      error: 'queue lookup failed — GitHub API unavailable',
    };
    const keptFrame = render(<QueueTab snapshot={kept} lanes={[]} />).lastFrame() ?? '';
    expect(keptFrame).toContain('(queue lookup failed — GitHub API unavailable)');
    expect(keptFrame).toContain('#61');
    expect(keptFrame.indexOf('queue lookup failed')).toBeLessThan(keptFrame.indexOf('#61'));
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
