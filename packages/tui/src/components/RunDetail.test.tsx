import type { EventKind, FactoryEvent } from '@on-par/factory-core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { initialState, reduceEvent } from '../state.js';
import { RunDetail } from './RunDetail.js';

afterEach(cleanup);

function ev(type: EventKind, msg: string, ts = '2026-01-01T00:00:00.000Z', issue = '296'): FactoryEvent {
  return { ts, type, issue, msg };
}

const NOW = Date.parse('2026-01-01T00:00:05.000Z');

describe('RunDetail', () => {
  it('shows the waiting message before any events arrive', () => {
    const { lastFrame } = render(<RunDetail run={initialState()} now={NOW} />);
    expect(lastFrame()).toContain('waiting for factory events');
  });

  it('renders Header, PhaseRow, and EventFeed once events arrive', () => {
    let run = initialState();
    run = reduceEvent(run, ev('plan', 'Starting plan phase'));
    run = reduceEvent(run, ev('router', 'Trying claude-sonnet for plan (attempt 1)'));

    const { lastFrame } = render(<RunDetail run={run} repo="on-par/software-factory" now={NOW} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('#296');
    expect(frame).toContain('on-par/software-factory');
    expect(frame).toContain('PLAN');
    expect(frame).toContain('claude-sonnet');
    expect(frame).toContain('Starting plan phase');
  });

  it('shows the back hint only when showBackHint is set', () => {
    const run = initialState();
    const withHint = render(<RunDetail run={run} now={NOW} showBackHint />);
    expect(withHint.lastFrame()).toContain('esc back · q quit');

    const withoutHint = render(<RunDetail run={run} now={NOW} />);
    expect(withoutHint.lastFrame()).not.toContain('esc back');
  });

  it('shows the queued steering count when greater than zero', () => {
    const { lastFrame } = render(<RunDetail run={initialState()} now={NOW} steeringQueued={2} />);
    expect(lastFrame()).toContain('steering: 2 message(s) queued for next phase boundary');
  });

  it('omits the queued steering line when zero or unset', () => {
    const zero = render(<RunDetail run={initialState()} now={NOW} steeringQueued={0} />);
    expect(zero.lastFrame()).not.toContain('queued for next phase boundary');

    const unset = render(<RunDetail run={initialState()} now={NOW} />);
    expect(unset.lastFrame()).not.toContain('queued for next phase boundary');
  });

  it('shows the issue title in the header when provided', () => {
    const run = reduceEvent(initialState(), ev('plan', 'Starting plan phase'));
    const { lastFrame } = render(<RunDetail run={run} title="Fix the flaky test" now={NOW} />);
    expect(lastFrame()).toContain('#296 Fix the flaky test');
  });

  it('shows elapsed time and last activity when provided', () => {
    const run = reduceEvent(initialState(), ev('plan', 'Starting plan phase'));
    const { lastFrame } = render(
      <RunDetail run={run} now={NOW} elapsedMs={65_000} lastActivityAt="2025-12-31T23:59:55.000Z" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('elapsed 01:05');
    expect(frame).toContain('last activity 10s ago');
  });

  it('omits the elapsed/last-activity line when neither is provided', () => {
    const { lastFrame } = render(<RunDetail run={initialState()} now={NOW} />);
    expect(lastFrame()).not.toContain('elapsed');
    expect(lastFrame()).not.toContain('last activity');
  });
});
