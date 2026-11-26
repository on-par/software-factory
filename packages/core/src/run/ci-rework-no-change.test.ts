import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { PreviewConfigSchema } from '../config/preview-section.js';
import type { ShipResult } from '../phases/ship.js';
import { recordArgs } from '../test-support/recorders.js';
import { CHECK_OK, policy, ports, request, resetCiReworkMocks, tmp } from './ci-rework-test-helpers.js';
import { runIssue, type RunPorts } from './run-issue.js';

afterAll(() => tmp.cleanup());
beforeEach(resetCiReworkMocks);

type ReworkOpts = Parameters<NonNullable<RunPorts['reworkWorker']>>[0];

const REMOTE_HEAD = 'c'.repeat(40);
const MERGED_HEAD = 'e'.repeat(40);
const CI_EVIDENCE = {
  failingChecks: [{ name: 'test (2/3)', conclusion: 'failure' }],
  alerts: [],
  truncated: false,
};
const FIRST_SHIP_CI_FAIL: ShipResult = {
  ok: false,
  prNumber: 9,
  reason: 'CI failed for PR #9',
  ciOutcome: 'failure',
  ciFailure: CI_EVIDENCE,
  headSha: REMOTE_HEAD,
};
const FIRST_SHIP_PREVIEW_FAIL: ShipResult = {
  ok: false,
  prNumber: 9,
  reason: 'preview check preview-unavailable for PR #9: never ready',
  previewCheck: {
    status: 'preview-unavailable',
    evidence: {
      headSha: REMOTE_HEAD,
      command: ['smoke'],
      readyWaitMs: 1,
      durationMs: 1,
      artifacts: [],
      reason: 'never ready',
    },
  },
  headSha: REMOTE_HEAD,
};
const PREVIEW = PreviewConfigSchema.parse({ source: { kind: 'deployment', environment: 'p/*' }, command: ['smoke'] });

function rig(queued: ShipResult[], heads: string[], preview: boolean) {
  const { calls: events, fn: log } = recordArgs((_type: string, _msg: string, _extra?: unknown) => {});
  const ships = recordArgs(async (_o: unknown) => (queued.length > 1 ? (queued.shift() as ShipResult) : queued[0]));
  const reworks = recordArgs(async (_o: ReworkOpts) => ({ failovers: [], modelCompleted: true }));
  const checks = recordArgs(async () => CHECK_OK);
  let read = 0;
  const readWorktreeHead = async () => heads[Math.min(read++, heads.length - 1)];
  const rigged: RunPorts = {
    ...ports(log),
    shipPhase: ships.fn,
    reworkWorker: reworks.fn,
    checkPhase: checks.fn,
    readWorktreeHead,
    loadPreviewConfig: () => (preview ? PREVIEW : undefined),
  };
  return { rigged, ships: ships.calls, reworks: reworks.calls, checks: checks.calls, events };
}

describe('shipWithCiRework — a CI rework round that makes no commit (#4337)', () => {
  it.each([
    { label: 'CI', first: FIRST_SHIP_CI_FAIL, preview: false, evidence: true },
    { label: 'preview', first: FIRST_SHIP_PREVIEW_FAIL, preview: true, evidence: false },
  ])(
    'a first-ship $label failure whose round-1 rework makes no commit parks ci-rework-no-change after one round',
    async ({ label, first, preview, evidence }) => {
      const { rigged, ships, reworks, checks, events } = rig([first], [REMOTE_HEAD], preview);
      expect(await runIssue(request, policy, rigged)).toMatchObject({
        state: 'parked',
        reason: 'ci-rework-no-change',
        prNumber: 9,
      });
      expect(reworks).toHaveLength(1);
      expect(checks).toHaveLength(1);
      expect(ships).toHaveLength(1);
      const parked = events.filter(([type]) => type === 'ci-rework-no-change');
      expect(parked).toHaveLength(1);
      expect(parked[0][1]).toContain(`ship phase failed: ${first.reason}`);
      expect(parked[0][1]).toContain(
        `${label} rework worker made no change (no new commit) on PR #9 (${request.branch})`,
      );
      expect(events.some(([type]) => type === 'ci-failed')).toBe(false);
      if (evidence) expect(parked[0][2]).toMatchObject({ ciFailure: { failingChecks: CI_EVIDENCE.failingChecks } });
    },
  );

  it.each([
    { label: 'a round-1 rework that commits', heads: [REMOTE_HEAD, 'd'.repeat(40)] },
    { label: 'a round after a base merge whose worker adds no commit', heads: [MERGED_HEAD, MERGED_HEAD] },
  ])('$label still rechecks and reships the new head', async ({ heads }) => {
    const queued: ShipResult[] = [FIRST_SHIP_CI_FAIL, { ok: true, prNumber: 9 }];
    const { rigged, ships, reworks, checks, events } = rig(queued, heads, false);
    expect(await runIssue(request, policy, rigged)).toMatchObject({ state: 'ready' });
    expect(reworks).toHaveLength(1);
    expect(checks).toHaveLength(2);
    expect(ships).toHaveLength(2);
    expect(ships[1][0]).toMatchObject({ reentry: { prNumber: 9, previousHeadSha: REMOTE_HEAD } });
    expect(events.some(([type]) => type === 'ci-rework-no-change')).toBe(false);
  });

  it.each([
    {
      label: 'a CodeQL suppression comment',
      diff:
        'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n' +
        '@@ -130,0 +130,1 @@\n+// codeql[js/request-forgery]\n',
    },
    {
      label: 'a workflow file edit',
      diff: 'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1 +1 @@\n+x\n',
    },
  ])('a no-commit round with $label still parks as a suppression attempt', async ({ diff }) => {
    const { rigged, ships, checks, events } = rig([FIRST_SHIP_CI_FAIL], [REMOTE_HEAD], false);
    rigged.readReworkDiff = async () => diff;
    expect(await runIssue(request, policy, rigged)).toMatchObject({ state: 'parked', reason: 'ci-failed' });
    expect(checks).toHaveLength(1);
    expect(ships).toHaveLength(1);
    const parked = events.filter(([type]) => type === 'ci-failed');
    expect(parked).toHaveLength(1);
    expect(parked[0][1]).toContain('suppression-attempt');
    expect(events.some(([type]) => type === 'ci-rework-no-change')).toBe(false);
  });
});
