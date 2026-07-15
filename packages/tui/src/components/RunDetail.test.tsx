import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { FactoryEvent } from '@on-par/factory-core';
import { initialState, reduceEvent } from '../state.js';
import { RunDetail } from './RunDetail.js';

afterEach(cleanup);

function ev(type: string, msg: string, ts = '2026-01-01T00:00:00.000Z', issue = '296'): FactoryEvent {
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
});
