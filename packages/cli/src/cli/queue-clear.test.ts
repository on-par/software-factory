// packages/cli/src/cli/queue-clear.test.ts — `factory queue clear` preview and exit codes (#1693).

import type { QueueClearPreview } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';

import { formatQueueClearPreview, runQueueClear } from './queue-clear.js';

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

describe('runQueueClear', () => {
  const previewClear = async () => preview;

  it('--dry-run prints the preview and exits 0', async () => {
    const result = await runQueueClear({ previewClear, dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain(formatQueueClearPreview(preview));
    expect(result.report).toContain('no GitHub labels changed');
  });

  it('--dry-run wins over --yes', async () => {
    expect((await runQueueClear({ previewClear, dryRun: true, yes: true })).exitCode).toBe(0);
  });

  it('exits 2 without --yes or --dry-run', async () => {
    const result = await runQueueClear({ previewClear });
    expect(result.exitCode).toBe(2);
    expect(result.report).toContain(formatQueueClearPreview(preview));
    expect(result.message).toContain('--yes');
  });

  it('refuses --yes because removal is not implemented', async () => {
    const result = await runQueueClear({ previewClear, yes: true });
    expect(result.exitCode).toBe(1);
    expect(result.report).toContain(formatQueueClearPreview(preview));
    expect(result.message).toContain('not implemented');
  });

  it.each([{}, { dryRun: true }, { yes: true }])('reports an empty queue with exit 0 (%j)', async (flags) => {
    const result = await runQueueClear({ previewClear: async () => empty, ...flags });
    expect(result).toEqual({ report: expect.stringContaining('already empty'), exitCode: 0 });
  });
});
