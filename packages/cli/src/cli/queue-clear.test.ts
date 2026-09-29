// packages/cli/src/cli/queue-clear.test.ts — `factory queue clear` preview and exit codes (#1693).

import type { QueueClearPreview, QueueClearResult } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { formatQueueClearPreview, formatQueueClearResult, runQueueClear } from './queue-clear.js';

const preview: QueueClearPreview = {
  entries: [
    { issue: 10, lanes: ['daw'], title: 'Queued issue', action: 'would-clear' },
    {
      issue: 11,
      lanes: ['daw'],
      action: 'would-skip',
      reason: 'claimed (factory:in-progress, factory:claimed-by:host-1)',
    },
    { issue: 12, lanes: [], action: 'would-clear' },
  ],
  wouldClear: 2,
  wouldSkip: 1,
};
const empty: QueueClearPreview = { entries: [], wouldClear: 0, wouldSkip: 0 };
const result: QueueClearResult = {
  entries: [
    { issue: 10, lanes: ['daw'], title: 'Queued issue', outcome: 'cleared' },
    {
      issue: 11,
      lanes: ['daw'],
      outcome: 'skipped',
      reason: 'claimed (factory:in-progress, factory:claimed-by:host-1)',
    },
    { issue: 12, lanes: [], outcome: 'cleared' },
  ],
  cleared: 2,
  skipped: 1,
  failed: 0,
};
const failedResult: QueueClearResult = {
  entries: [...result.entries, { issue: 13, lanes: ['docs'], outcome: 'failed', reason: 'boom' }],
  cleared: 2,
  skipped: 1,
  failed: 1,
};
const emptyResult: QueueClearResult = { entries: [], cleared: 0, skipped: 0, failed: 0 };

describe('formatQueueClearPreview', () => {
  it('renders lanes, skip reasons, titles, and the count line', () => {
    expect(formatQueueClearPreview(preview)).toBe(
      [
        '  #10 [lane daw] would-clear — Queued issue',
        '  #11 [lane daw] would-skip — claimed (factory:in-progress, factory:claimed-by:host-1)',
        '  #12 [lane (none)] would-clear',
        '3 queued issue(s): 2 would-clear, 1 would-skip',
      ].join('\n'),
    );
  });
});

describe('formatQueueClearResult', () => {
  it('renders lanes, skip reasons, titles, and the count line', () => {
    expect(formatQueueClearResult(result)).toBe(
      [
        '  #10 [lane daw] cleared — Queued issue',
        '  #11 [lane daw] skipped — claimed (factory:in-progress, factory:claimed-by:host-1)',
        '  #12 [lane (none)] cleared',
        '3 queued issue(s): 2 cleared, 1 skipped',
      ].join('\n'),
    );
  });

  it('appends the failed count and reason only when something failed', () => {
    const text = formatQueueClearResult(failedResult);
    expect(text).toContain('  #13 [lane docs] failed — boom');
    expect(text.endsWith('4 queued issue(s): 2 cleared, 1 skipped, 1 failed')).toBe(true);
  });
});

describe('runQueueClear', () => {
  const previewClear = async () => preview;
  const clear = async () => result;

  it('--dry-run prints the preview and exits 0', async () => {
    const result = await runQueueClear({ previewClear, clear, dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain(formatQueueClearPreview(preview));
    expect(result.report).toContain('no GitHub labels changed');
  });

  it('--dry-run wins over --yes', async () => {
    expect((await runQueueClear({ previewClear, clear, dryRun: true, yes: true })).exitCode).toBe(0);
  });

  it('exits 2 without --yes or --dry-run', async () => {
    const result = await runQueueClear({ previewClear, clear });
    expect(result.exitCode).toBe(2);
    expect(result.report).toContain(formatQueueClearPreview(preview));
    expect(result.message).toContain('--yes');
  });

  it('--yes clears via clear() and exits 0', async () => {
    const clearSpy = vi.fn(clear);
    const previewSpy = vi.fn(previewClear);
    const res = await runQueueClear({ previewClear: previewSpy, clear: clearSpy, yes: true });
    expect(res.exitCode).toBe(0);
    expect(res.message).toBeUndefined();
    expect(res.report).toContain(formatQueueClearResult(result));
    expect(clearSpy).toHaveBeenCalledOnce();
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('--yes exits 1 after printing every line when an issue failed', async () => {
    const res = await runQueueClear({ previewClear, clear: async () => failedResult, yes: true });
    expect(res.exitCode).toBe(1);
    expect(res.message).toContain('failed');
    expect(res.report).toContain(formatQueueClearResult(failedResult));
  });

  it('--yes reports an empty queue with exit 0', async () => {
    const res = await runQueueClear({ previewClear, clear: async () => emptyResult, yes: true });
    expect(res).toEqual({ report: expect.stringContaining('already empty'), exitCode: 0 });
  });

  it('--dry-run with --yes previews and never calls clear()', async () => {
    const clearSpy = vi.fn(clear);
    const res = await runQueueClear({ previewClear, clear: clearSpy, dryRun: true, yes: true });
    expect(res.report).toContain('dry run');
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it.each([{}, { dryRun: true }, { yes: true }])('reports an empty queue with exit 0 (%j)', async (flags) => {
    const result = await runQueueClear({ previewClear: async () => empty, clear: async () => emptyResult, ...flags });
    expect(result).toEqual({ report: expect.stringContaining('already empty'), exitCode: 0 });
  });
});
