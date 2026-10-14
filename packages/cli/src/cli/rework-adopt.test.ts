import type { FactoryEvent } from '@on-par/factory-core';
import { describe, expect, it } from 'vitest';

import type { OpenPullRequestEvidence } from './queue-preflight.js';
import { decideReworkAdoption, lastParkEvent, renderReworkBrief } from './rework-adopt.js';

const ev = (type: FactoryEvent['type'], issue: string, extra: Partial<FactoryEvent> = {}): FactoryEvent => ({
  ts: '2026-01-01T00:00:00.000Z',
  type,
  issue,
  msg: `${type} msg`,
  ...extra,
});

const pr: OpenPullRequestEvidence = {
  number: 71,
  branch: 'factory/7-fix-it',
  headSha: 'abcdef1234567890',
  headRepoFullName: 'on-par/software-factory',
};
const base = { issue: 7, expectedHeadRepoFullName: 'on-par/software-factory', branchPrefix: 'factory' };

describe('lastParkEvent', () => {
  it('picks the last park for the issue, ignoring other issues and non-park kinds', () => {
    const events = [
      ev('ci-failed', '7', { msg: 'first' }),
      ev('escalate', '7', { msg: 'second' }),
      ev('ci-failed', '8', { msg: 'other issue' }),
      ev('build', '7'),
    ];
    expect(lastParkEvent(events, 7)?.msg).toBe('second');
  });

  it('returns undefined with no events or no park', () => {
    expect(lastParkEvent([], 7)).toBeUndefined();
    expect(lastParkEvent([ev('build', '7')], 7)).toBeUndefined();
  });
});

describe('decideReworkAdoption', () => {
  it('adopts on ci-failed + same repo + factory ref', () => {
    expect(decideReworkAdoption({ ...base, pr, lastPark: ev('ci-failed', '7') })).toEqual({
      number: 71,
      branch: 'factory/7-fix-it',
      headSha: 'abcdef1234567890',
    });
  });

  it.each(['ci-infra', 'fail', 'escalate'] as const)('does not adopt after a %s park', (type) => {
    expect(decideReworkAdoption({ ...base, pr, lastPark: ev(type, '7') })).toBeUndefined();
  });

  it('does not adopt without a park event', () => {
    expect(decideReworkAdoption({ ...base, pr, lastPark: undefined })).toBeUndefined();
  });

  it('does not adopt a fork head, a non-factory ref, or another issue branch', () => {
    const lastPark = ev('ci-failed', '7');
    expect(decideReworkAdoption({ ...base, pr: { ...pr, headRepoFullName: 'fork/repo' }, lastPark })).toBeUndefined();
    expect(decideReworkAdoption({ ...base, pr: { ...pr, headRepoFullName: null }, lastPark })).toBeUndefined();
    expect(decideReworkAdoption({ ...base, pr: { ...pr, branch: 'contributor/x' }, lastPark })).toBeUndefined();
    expect(decideReworkAdoption({ ...base, pr: { ...pr, branch: 'factory/8-other' }, lastPark })).toBeUndefined();
  });
});

describe('renderReworkBrief', () => {
  const rp = { number: 71, branch: 'factory/7-fix-it', headSha: 'abcdef1234567890' };

  it('includes the PR, SHA, failing checks and alerts', () => {
    const park = ev('ci-failed', '7', {
      ciFailure: {
        failingChecks: [{ name: 'CodeQL', conclusion: 'failure', summary: 'bad flow' }],
        alerts: [{ ruleId: 'js/xss', location: 'src/a.ts:3', message: 'unsafe' }],
        truncated: true,
      },
    });
    const out = renderReworkBrief(rp, park);
    expect(out).toContain('## Prior CI failure (adopted PR #71)');
    expect(out).toContain('abcdef1234567890');
    expect(out).toContain('CodeQL (failure): bad flow');
    expect(out).toContain('js/xss @ src/a.ts:3: unsafe');
    expect(out).toContain('truncated');
    expect(out).toContain(park.ts);
  });

  it('renders only the pointer lines without ciFailure', () => {
    const out = renderReworkBrief(rp, undefined);
    expect(out).toContain('factory/7-fix-it');
    expect(out).not.toContain('Failing checks');
    expect(out).toContain('on top of the existing branch');
  });
});
