import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreviewConfigSchema } from '../config/preview-section.js';
import type { ShipResult } from '../phases/ship.js';
import {
  checkPhase,
  type Log,
  policy,
  ports,
  readReworkDiff,
  request,
  resetCiReworkMocks,
  reworkWorker,
  shipPhase,
  tmp,
} from './ci-rework-test-helpers.js';
import { runIssue, type RunPorts } from './run-issue.js';

afterAll(() => tmp.cleanup());
beforeEach(resetCiReworkMocks);

describe('shipWithCiRework — preview gate (#3880)', () => {
  const PREVIEW = PreviewConfigSchema.parse({ source: { kind: 'deployment', environment: 'p/*' }, command: ['smoke'] });
  const evidence = {
    headSha: 'sha',
    command: ['smoke'],
    readyWaitMs: 1,
    durationMs: 1,
    artifacts: [],
    reason: 'never ready',
  };
  const PREVIEW_FAIL: ShipResult = {
    ok: false,
    prNumber: 9,
    reason: 'preview check preview-unavailable for PR #9: never ready',
    previewCheck: { status: 'preview-unavailable', evidence },
    headSha: 'sha',
  };
  const withPreview = (log: Log): RunPorts => ({ ...ports(log), loadPreviewConfig: () => PREVIEW });

  it('passes no previewGate to SHIP when the repo has no preview config', async () => {
    shipPhase.mockResolvedValueOnce({ ok: true, prNumber: 9 });
    await runIssue(request, policy, { ...ports(vi.fn<Log>()), loadPreviewConfig: () => undefined });
    expect(shipPhase.mock.calls[0][0]).not.toHaveProperty('previewGate');
  });

  it('a failed preview check runs a rework round, re-checks and re-enters SHIP', async () => {
    shipPhase.mockResolvedValueOnce(PREVIEW_FAIL).mockResolvedValueOnce({ ok: true, prNumber: 9 });
    const log = vi.fn<Log>();
    expect(await runIssue(request, policy, withPreview(log))).toMatchObject({ state: 'ready' });
    expect(shipPhase.mock.calls[0][0]).toHaveProperty('previewGate');
    expect(reworkWorker.mock.calls[0][0].extraInstructions).toContain('deployed preview failed');
    expect(reworkWorker.mock.calls[0][0].summary.results[0].details).toContain('Preview check: preview-unavailable');
    expect(checkPhase).toHaveBeenCalledTimes(2);
    expect(shipPhase.mock.calls[1][0]).toMatchObject({ reentry: { prNumber: 9 } });
    expect(log).toHaveBeenCalledWith('rework', 'CI rework round 1/2: preview check preview-unavailable on PR #9');
  });

  it('parks fail with the preview reason when the rework budget is exhausted', async () => {
    shipPhase.mockResolvedValue(PREVIEW_FAIL);
    const log = vi.fn<Log>();
    expect(await runIssue(request, policy, withPreview(log))).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(reworkWorker).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      'fail',
      'ship phase failed: preview check preview-unavailable for PR #9: never ready — preview rework budget exhausted after 2 rounds',
      expect.anything(),
    );
  });

  it('applies the suppression guard to preview rework', async () => {
    shipPhase.mockResolvedValueOnce(PREVIEW_FAIL);
    readReworkDiff.mockResolvedValue(
      'diff --git a/max-lines-baseline.json b/max-lines-baseline.json\n--- a/max-lines-baseline.json\n+++ b/max-lines-baseline.json\n@@ -3 +3 @@\n-  "a.ts": 789,\n+  "a.ts": 790,\n',
    );
    expect(await runIssue(request, policy, withPreview(vi.fn<Log>()))).toMatchObject({ reason: 'ci-failed' });
    expect(shipPhase).toHaveBeenCalledTimes(1);
  });

  it('does not spend a rework round while CI is pending and parks fail with the reason', async () => {
    const pending: ShipResult = {
      ok: false,
      prNumber: 9,
      reason: 'preview check preview-unavailable for PR #9: CI pending, preview not checked',
      previewCheck: {
        status: 'preview-unavailable',
        evidence: { ...evidence, reason: 'CI pending, preview not checked' },
      },
      ciOutcome: 'timeout',
      ciPending: true,
      draft: true,
      headSha: 'sha',
    };
    shipPhase.mockResolvedValue(pending);
    const log = vi.fn<Log>();
    expect(await runIssue(request, policy, withPreview(log))).toMatchObject({ state: 'parked', reason: 'fail' });
    expect(reworkWorker).not.toHaveBeenCalled();
    expect(shipPhase).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'fail',
      'ship phase failed: preview check preview-unavailable for PR #9: CI pending, preview not checked',
      expect.anything(),
    );
  });
});
