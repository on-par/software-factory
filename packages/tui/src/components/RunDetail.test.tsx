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

  it('shows enriched failure evidence with a sanitized related filed issue link', () => {
    const withEvidence = render(
      <RunDetail
        run={initialState()}
        now={NOW}
        failureEvidence={{
          reason: 'verify_failed',
          fingerprint: 'ff_0123456789abcdef',
          eventExcerpt: 'tests\u001b[2J failed',
          logPath: '/tmp/\u001b[Hfactory.log',
          relatedIssue: { repo: 'on-par/software-factory', issueNumber: 1392 },
        }}
      />,
    );
    expect(withEvidence.lastFrame()).toContain('failure reason: verify_failed');
    expect(withEvidence.lastFrame()).toContain('failure fingerprint: ff_0123456789abcdef');
    expect(withEvidence.lastFrame()).toContain('failure excerpt: tests[2J failed');
    expect(withEvidence.lastFrame()).toContain('failure log: /tmp/[Hfactory.log');
    expect(withEvidence.lastFrame()).toContain(
      'related filed issue: https://github.com/on-par/software-factory/issues/1392',
    );
    expect(withEvidence.lastFrame()).not.toContain('\u001b');
    expect(withEvidence.lastFrame()).not.toContain('failure event/log:');

    const withoutEvidence = render(<RunDetail run={initialState()} now={NOW} />);
    expect(withoutEvidence.lastFrame()).not.toContain('failure reason:');
    expect(withoutEvidence.lastFrame()).not.toContain('failure fingerprint:');
    expect(withoutEvidence.lastFrame()).not.toContain('failure event/log:');
  });

  it('renders a sanitized legacy failure event/log pointer without structured evidence', () => {
    const { lastFrame } = render(
      <RunDetail run={initialState()} now={NOW} legacyFailurePointer={'see \u001b[2J/tmp/legacy-event.log'} />,
    );

    expect(lastFrame()).toContain('failure event/log: see [2J/tmp/legacy-event.log');
    expect(lastFrame()).not.toContain('\u001b');
  });

  it('renders excerpt and log without a related filed issue when the reference is absent', () => {
    const { lastFrame } = render(
      <RunDetail
        run={initialState()}
        now={NOW}
        failureEvidence={{
          reason: 'verify_failed',
          fingerprint: 'ff_0123456789abcdef',
          eventExcerpt: 'tests failed',
          logPath: '/tmp/factory.log',
        }}
      />,
    );

    expect(lastFrame()).toContain('failure excerpt: tests failed');
    expect(lastFrame()).toContain('failure log: /tmp/factory.log');
    expect(lastFrame()).not.toContain('related filed issue:');
    expect(lastFrame()).not.toContain('https://github.com/');
  });
});
