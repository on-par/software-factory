import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import type { PreviewCheckResult } from './preview-evidence.js';
import {
  PREVIEW_RECEIPT_END,
  PREVIEW_RECEIPT_START,
  publishPreviewReceipt,
  renderPreviewReceipt,
} from './preview-receipt.js';

const SHA = 'abcdef1234567890'.padEnd(40, '0');

const result = (over: Partial<PreviewCheckResult['evidence']> = {}): PreviewCheckResult => ({
  status: 'fail',
  evidence: {
    url: 'https://p.example.com/?***',
    headSha: SHA,
    command: ['npm', 'run', 'smoke'],
    exitCode: 1,
    readyWaitMs: 4000,
    commandMs: 2500,
    durationMs: 6500,
    artifacts: ['playwright-report'],
    artifactsDir: '/logs/preview-artifacts',
    ...over,
  },
});

function fakeOctokit(body: string | null) {
  const get = vi.fn(async (_args: { pull_number: number }) => ({ data: { body } }));
  const update = vi.fn(async (_args: { pull_number: number; body: string }) => ({ data: {} }));
  const octokit: Octokit = Object.assign(Object.create(null), { rest: { pulls: { get, update } } });
  return { octokit, get, update };
}

describe('renderPreviewReceipt', () => {
  it('shows the verdict, masked URL, short SHA, command, timings, exit code and artifacts in a marked block', () => {
    expect(renderPreviewReceipt(result())).toBe(
      [
        PREVIEW_RECEIPT_START,
        '### Preview check',
        '',
        '**Result: fail** on `https://p.example.com/?***` at `abcdef123456`',
        '',
        '- Command: `npm run smoke`',
        '- Ready wait: 4.0s; command: 2.5s',
        '- Exit code: 1',
        '- Artifacts: playwright-report (copied to the run logs)',
        '',
        "_Run by the factory against the PR's preview after CI. Regenerated on each SHIP._",
        PREVIEW_RECEIPT_END,
      ].join('\n'),
    );
  });

  it('shows the reason when the preview was unavailable', () => {
    const unavailable: PreviewCheckResult = {
      status: 'preview-unavailable',
      evidence: { headSha: SHA, command: [], readyWaitMs: 0, durationMs: 0, artifacts: [], reason: 'CI pending' },
    };
    const receipt = renderPreviewReceipt(unavailable);
    expect(receipt).toContain('**Result: preview-unavailable** on `-` at `abcdef123456`');
    expect(receipt).toContain('- Reason: CI pending');
    expect(receipt).not.toContain('Exit code');
    expect(receipt).not.toContain('Artifacts');
  });
});

describe('publishPreviewReceipt', () => {
  it('appends the receipt to the PR body and keeps the rest of the body', async () => {
    const f = fakeOctokit('Closes #5');
    await publishPreviewReceipt(f.octokit, 'o', 'r', 5, result());
    expect(f.update).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      pull_number: 5,
      body: `Closes #5\n\n${renderPreviewReceipt(result())}\n`,
    });
  });

  it('replaces the previous receipt after a rework round', async () => {
    const f = fakeOctokit(`Closes #5\n\n${renderPreviewReceipt(result())}\n`);
    const passed: PreviewCheckResult = { ...result({ exitCode: 0 }), status: 'pass' };
    await publishPreviewReceipt(f.octokit, 'o', 'r', 5, passed);
    expect(f.update.mock.calls[0]?.[0].body).toBe(`Closes #5\n\n${renderPreviewReceipt(passed)}\n`);
  });

  it('does not write when the body already holds this receipt', async () => {
    const f = fakeOctokit(renderPreviewReceipt(result()));
    await publishPreviewReceipt(f.octokit, 'o', 'r', 5, result());
    expect(f.update).not.toHaveBeenCalled();
  });
});
