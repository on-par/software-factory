import { describe, expect, it, vi } from 'vitest';

import { type FlakyRerunContext, rerunChecksWithNoBaseResult } from './ship-ci-flaky.js';
import {
  FLAKY_CHECK,
  FLAKY_HEAD,
  FLAKY_RERUN_ARGV,
  flakyCiRig,
  type FlakyCiRigOptions,
} from '../test-support/ship-ci-flaky-rig.js';

const BASE_LABEL = `main@${'b'.repeat(12)}`;
const NAMED = `check(s) ${FLAKY_CHECK} had no result on base ${BASE_LABEL}`;

async function watchWith(opts: FlakyCiRigOptions) {
  const rig = flakyCiRig(opts);
  const logs: Array<[string, string]> = [];
  const ci = await rig.watch((type, msg) => logs.push([type, msg]));
  return { ci, logs, reruns: rig.reruns, watches: rig.watches };
}

describe('watchShipCi — a failing check with no result on the base commit (#4337)', () => {
  it('reruns its failed jobs once and continues as green when the rerun passes', async () => {
    const { ci, logs, reruns, watches } = await watchWith({ base: 'none', outcomes: ['failure', 'success'] });
    expect(ci).toEqual({ ciOutcome: 'success', ciWatchError: undefined });
    expect(reruns).toEqual([FLAKY_RERUN_ARGV]);
    expect(watches).toEqual(['failure', 'success']);
    expect(logs.filter(([type]) => type === 'ci-flaky-rerun-green')).toEqual([
      ['ci-flaky-rerun-green', `CI for PR #9: ${NAMED} and went green after one rerun; shipping without rework`],
    ]);
    expect(logs).toContainEqual(['ship', 'CI green for PR #9']);
  });

  it.each([
    { label: 'fails again', outcome: 'failure' as const },
    { label: 'ends as an infra failure', outcome: 'infra-failure' as const },
  ])('flags the still-red check after one rerun when the re-watch $label', async ({ outcome }) => {
    const { ci, logs, reruns, watches } = await watchWith({ base: 'none', outcomes: ['failure', outcome] });
    const reason = `CI failed for PR #9: ${NAMED} and still failed after one rerun`;
    expect(ci.result).toMatchObject({
      ok: false,
      prNumber: 9,
      reason,
      ciOutcome: 'failure',
      headSha: FLAKY_HEAD,
      ciFlaky: { checks: [FLAKY_CHECK] },
      ciFailure: { failingChecks: [{ name: FLAKY_CHECK, conclusion: 'failure' }], alerts: [] },
    });
    expect(reruns).toEqual([FLAKY_RERUN_ARGV]);
    expect(watches).toEqual(['failure', outcome]);
    expect(logs).toContainEqual(['ship', reason]);
    expect(logs.some(([type]) => type === 'ci-flaky-rerun-green')).toBe(false);
  });

  it.each([
    { label: 'the check passes on base', opts: { base: 'passing' as const }, note: undefined },
    { label: 'the check also fails on base', opts: { base: 'failing' as const }, note: undefined },
    {
      label: 'the shared rerun budget is already spent for the head',
      opts: { base: 'none' as const, budget: new Set([FLAKY_HEAD]) },
      note: `the rerun budget for ${'c'.repeat(12)} is already spent`,
    },
    {
      label: 'the infra rerun spent the shared budget during the watch',
      opts: { base: 'none' as const, infraSpendsBudget: true },
      note: `the rerun budget for ${'c'.repeat(12)} is already spent`,
    },
  ])('reports the plain CI failure without a rerun when $label', async ({ opts, note }) => {
    const { ci, logs, reruns, watches } = await watchWith({ ...opts, outcomes: ['failure', 'success'] });
    expect(ci.result).toMatchObject({ ok: false, prNumber: 9, reason: 'CI failed for PR #9', ciOutcome: 'failure' });
    expect(ci.result?.ciFlaky).toBeUndefined();
    expect(reruns).toEqual([]);
    expect(watches).toEqual(['failure']);
    expect(logs.some(([type]) => type === 'ci-flaky-rerun-green')).toBe(false);
    const skipNote = logs.filter(([, msg]) => msg.includes('not rerun')).map(([, msg]) => msg);
    expect(skipNote).toEqual(note ? [`CI for PR #9: ${NAMED}; not rerun: ${note}`] : []);
  });

  it('reports the plain CI failure when the rerun command itself fails', async () => {
    const { ci, logs, reruns, watches } = await watchWith({ base: 'none', outcomes: ['failure'], rerunOk: false });
    expect(ci.result).toMatchObject({ reason: 'CI failed for PR #9', ciOutcome: 'failure' });
    expect(ci.result?.ciFlaky).toBeUndefined();
    expect(reruns).toEqual([FLAKY_RERUN_ARGV]);
    expect(watches).toEqual(['failure']);
    const warning = `CI for PR #9: could not rerun failed job(s) in run(s) 507 for check(s) ${FLAKY_CHECK}`;
    expect(logs).toContainEqual(['warn', warning]);
  });
});

describe('rerunChecksWithNoBaseResult (#4337)', () => {
  type Over = Partial<FlakyRerunContext>;
  const ctx = (over: Over, logs: Array<[string, string]>, bases: string[]): FlakyRerunContext => ({
    octokit: {} as FlakyRerunContext['octokit'],
    owner: 'o',
    repoName: 'r',
    prNumber: 9,
    watchRef: 'b',
    baseRef: 'main',
    evidence: { failingChecks: [{ name: FLAKY_CHECK, conclusion: 'failure' }], alerts: [], truncated: false },
    rerunBudget: new Set(),
    rewatch: async () => 'success',
    listBase: vi.fn(async () => {
      bases.push('listed');
      throw new Error('base lookup boom');
    }),
    log: (type, msg) => logs.push([type, msg]),
    ...over,
  });

  const rows: { label: string; over: Over; bases: string[]; logs: Array<[string, string]> }[] = [
    {
      label: 'the failure carries CodeQL alerts',
      over: {
        evidence: {
          failingChecks: [{ name: 'CodeQL', conclusion: 'failure' }],
          alerts: [{ ruleId: 'js/xss', location: 'a.ts:1', message: 'm' }],
          truncated: false,
        },
      },
      bases: [],
      logs: [],
    },
    {
      label: 'no check failed',
      over: { evidence: { failingChecks: [], alerts: [], truncated: false } },
      bases: [],
      logs: [],
    },
    {
      label: 'the base lookup throws',
      over: {},
      bases: ['listed'],
      logs: [['warn', 'CI flaky-check rerun for PR #9 failed: base lookup boom; continuing without it']],
    },
  ];

  it.each(rows)('skips the rerun when $label', async (row) => {
    const logs: Array<[string, string]> = [];
    const bases: string[] = [];
    expect(await rerunChecksWithNoBaseResult(ctx(row.over, logs, bases))).toEqual({ kind: 'skipped' });
    expect(bases).toEqual(row.bases);
    expect(logs).toEqual(row.logs);
  });
});
