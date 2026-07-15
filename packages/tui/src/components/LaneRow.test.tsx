import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { initialDashboard, reduceDashboard, type LaneState } from '../dashboard.js';
import { LaneRow } from './LaneRow.js';

afterEach(cleanup);

function laneFor(events: Array<{ type: string; msg: string; ts?: string }>, issue = '296'): LaneState {
  let state = initialDashboard();
  for (const e of events) {
    state = reduceDashboard(state, { ts: e.ts ?? '2026-01-01T00:00:00.000Z', type: e.type, issue, msg: e.msg });
  }
  return state.lanes[0];
}

const NOW = Date.parse('2026-01-01T00:00:05.000Z');

describe('LaneRow', () => {
  it('renders a running lane with the spinner and active phase', () => {
    const lane = laneFor([{ type: 'plan', msg: 'Starting plan phase' }]);
    const { lastFrame } = render(<LaneRow lane={lane} selected={false} now={NOW} />);
    expect(lastFrame()).toContain('PLAN');
  });

  it('renders a ready lane with the parsed PR number', () => {
    const lane = laneFor([
      { type: 'plan', msg: 'Starting plan phase' },
      { type: 'ready', msg: 'PR #123 ready for review' },
    ]);
    const { lastFrame } = render(<LaneRow lane={lane} selected={false} now={NOW} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✔');
    expect(frame).toContain('ready');
    expect(frame).toContain('PR #123');
  });

  it('renders a waiting-merge lane with its train position', () => {
    const lane = laneFor([
      { type: 'plan', msg: 'Starting plan phase' },
      { type: 'await-merge', msg: 'waiting to merge x' },
    ]);
    const { lastFrame } = render(<LaneRow lane={lane} selected={false} now={NOW} trainPosition={2} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⏳');
    expect(frame).toContain('waiting to merge');
    expect(frame).toContain('#2 in train');
  });

  it('renders a merged lane with the PR number', () => {
    const lane = laneFor([
      { type: 'plan', msg: 'Starting plan phase' },
      { type: 'landed', msg: 'PR merged' },
    ]);
    const withPr: LaneState = { ...lane, prNumber: '42' };
    const { lastFrame } = render(<LaneRow lane={withPr} selected={false} now={NOW} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✔');
    expect(frame).toContain('merged PR #42');
  });

  it('renders a failed lane with the failing phase', () => {
    const lane = laneFor([
      { type: 'plan', msg: 'Starting plan phase' },
      { type: 'build', msg: 'Starting build phase (route: claude)' },
      { type: 'fail', msg: 'boom' },
    ]);
    const { lastFrame } = render(<LaneRow lane={lane} selected={false} now={NOW} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✖');
    expect(frame).toContain('BUILD');
  });

  it('renders a stopped lane', () => {
    const lane = laneFor([
      { type: 'plan', msg: 'Starting plan phase' },
      { type: 'stopped', msg: 'STOP flag present' },
    ]);
    const { lastFrame } = render(<LaneRow lane={lane} selected={false} now={NOW} />);
    expect(lastFrame()).toContain('stopped');
  });

  it('shows a cyan caret when selected and nothing when not', () => {
    const lane = laneFor([{ type: 'plan', msg: 'Starting plan phase' }]);
    const selected = render(<LaneRow lane={lane} selected now={NOW} />);
    const unselected = render(<LaneRow lane={lane} selected={false} now={NOW} />);
    expect(selected.lastFrame()).toContain('❯');
    expect(unselected.lastFrame()).not.toContain('❯');
  });

  it('truncates long titles and shows the issue number, model, and elapsed time', () => {
    const base = laneFor([
      { type: 'plan', msg: 'Starting plan phase', ts: '2026-01-01T00:00:00.000Z' },
      { type: 'router', msg: 'Trying claude-sonnet for plan (attempt 1)' },
    ]);
    const lane: LaneState = { ...base, title: 'A'.repeat(50) };
    const { lastFrame } = render(<LaneRow lane={lane} selected={false} now={NOW} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('#296');
    expect(frame).toContain('…');
    expect(frame).not.toContain('A'.repeat(40));
    expect(frame).toContain('claude-sonnet');
    expect(frame).toContain('00:05');
  });
});
