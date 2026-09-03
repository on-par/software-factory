import { createLocalBriefAdapter, type BriefFileReader } from '@on-par/factory-core';
import { describe, expect, it } from 'vitest';

import { materializeBrief, materializeRetryBrief } from './brief.js';
import type { ScbenchCheckpoint } from './checkpoint.js';
import type { ScbenchRetryContext } from './retry-context.js';

const CHECKPOINT: ScbenchCheckpoint = {
  problemId: 'calculator',
  checkpointId: '2',
  index: 1,
  task: 'Add a `subtract` function to calc.py that returns a - b.',
};

describe('materializeBrief', () => {
  it('titles the brief with the problem and checkpoint id', () => {
    const brief = materializeBrief(CHECKPOINT);
    expect(brief).toMatch(/^# SCBench calculator — checkpoint 2\n/);
  });

  it('embeds the task verbatim', () => {
    const brief = materializeBrief(CHECKPOINT);
    expect(brief).toContain(CHECKPOINT.task);
  });

  it('includes a non-empty acceptance criteria section', () => {
    const brief = materializeBrief(CHECKPOINT);
    expect(brief).toContain('## Acceptance criteria');
    expect(brief).toContain('- Every example in the specification above reproduces exactly.');
  });

  it('acceptance criteria are generic and spec-derived', () => {
    const brief = materializeBrief(CHECKPOINT);
    expect(brief).toContain('## Acceptance criteria');
    expect(brief).toContain('Every example in the specification above reproduces exactly.');
    expect(brief).toContain('Behaviour from earlier checkpoints is preserved.');
    expect(brief).toContain("The workspace's test suite passes.");
  });

  it('no longer states the tautological hidden-evaluation line', () => {
    const brief = materializeBrief(CHECKPOINT);
    expect(brief).not.toMatch(/hidden evaluation for checkpoint/i);
    expect(brief).not.toContain('SlopCodeBench');
  });

  it('round-trips through createLocalBriefAdapter (#507 validation)', async () => {
    const brief = materializeBrief(CHECKPOINT);
    const reader: BriefFileReader = { readFile: async () => brief };
    const adapter = createLocalBriefAdapter(reader);

    const request = await adapter.resolve({ path: '/tmp/checkpoint.md' });

    expect(request.title).toBe('SCBench calculator — checkpoint 2');
    expect(request.brief).toContain(CHECKPOINT.task);
    expect(request.acceptanceCriteria.length).toBeGreaterThanOrEqual(3);
  });

  it('embeds a task that itself contains an H1 without breaking the title', async () => {
    const checkpoint: ScbenchCheckpoint = { ...CHECKPOINT, task: '# Not the real title\n\nDo the thing.' };
    const brief = materializeBrief(checkpoint);
    const reader: BriefFileReader = { readFile: async () => brief };
    const adapter = createLocalBriefAdapter(reader);

    const request = await adapter.resolve({ path: '/tmp/checkpoint.md' });

    expect(request.title).toBe('SCBench calculator — checkpoint 2');
    expect(request.brief).toContain('Do the thing.');
  });
});

const RETRY_CONTEXT: ScbenchRetryContext = {
  problemId: 'calculator',
  checkpointId: '2',
  passPolicy: 'core-cases',
  pytestExitCode: 1,
  failedTests: [
    { group: 'checkpoint_2-Core', name: 'test_subtract_negative' },
    { group: 'checkpoint_2-Error', name: 'test_subtract_type_error' },
  ],
};

describe('materializeRetryBrief', () => {
  it('embeds the original task verbatim under a rework title', () => {
    const brief = materializeRetryBrief(CHECKPOINT, RETRY_CONTEXT);

    expect(brief).toMatch(/^# SCBench calculator — checkpoint 2 \(rework\)\n/);
    expect(brief).toContain(CHECKPOINT.task);
  });

  it('lists each failing test with its group and the pass policy line', () => {
    const brief = materializeRetryBrief(CHECKPOINT, RETRY_CONTEXT);

    expect(brief).toContain('## Previous attempt failed SCBench evaluation');
    expect(brief).toContain('Pass policy `core-cases`; pytest exit code 1.');
    expect(brief).toContain('- checkpoint_2-Core: test_subtract_negative');
    expect(brief).toContain('- checkpoint_2-Error: test_subtract_type_error');
  });

  it('falls back to a make-all-groups-pass line when no per-test names were recorded', () => {
    const brief = materializeRetryBrief(CHECKPOINT, { ...RETRY_CONTEXT, failedTests: [] });

    expect(brief).toContain('No per-test names were recorded; make all evaluation groups pass.');
    expect(brief).not.toContain('Failing tests that must pass:');
  });

  it('renders stderr/stdout excerpt sections only when excerpts exist', () => {
    const without = materializeRetryBrief(CHECKPOINT, RETRY_CONTEXT);
    expect(without).not.toContain('### stderr excerpt');
    expect(without).not.toContain('### stdout excerpt');

    const withExcerpts = materializeRetryBrief(CHECKPOINT, {
      ...RETRY_CONTEXT,
      stdoutExcerpt: '2 failed, 4 passed',
      stderrExcerpt: 'AssertionError: boom',
    });
    expect(withExcerpts).toContain('### stderr excerpt\n\n```\nAssertionError: boom\n```');
    expect(withExcerpts).toContain('### stdout excerpt\n\n```\n2 failed, 4 passed\n```');
  });

  it('includes a non-empty acceptance criteria section', () => {
    const brief = materializeRetryBrief(CHECKPOINT, RETRY_CONTEXT);

    expect(brief).toContain('## Acceptance criteria');
    expect(brief).toContain('- Every example in the specification above reproduces exactly.');
    expect(brief).toContain('- Behaviour from earlier checkpoints is preserved.');
    expect(brief).toContain("- The workspace's test suite passes.");
    expect(brief).toContain('- The failing tests listed above pass.');
  });

  it('retry brief keeps the failing-test list and adds the generic bullets', () => {
    const brief = materializeRetryBrief(CHECKPOINT, RETRY_CONTEXT);

    // failing-test list unchanged
    expect(brief).toContain('## Previous attempt failed SCBench evaluation');
    expect(brief).toContain('Pass policy `core-cases`; pytest exit code 1.');
    expect(brief).toContain('Failing tests that must pass:');
    expect(brief).toContain('- checkpoint_2-Core: test_subtract_negative');
    expect(brief).toContain('- checkpoint_2-Error: test_subtract_type_error');

    // generic bullets added
    expect(brief).toContain('## Acceptance criteria');
    expect(brief).toContain('- Every example in the specification above reproduces exactly.');
    expect(brief).toContain('- Behaviour from earlier checkpoints is preserved.');
    expect(brief).toContain("- The workspace's test suite passes.");
    expect(brief).toContain('- The failing tests listed above pass.');
  });

  it('round-trips through createLocalBriefAdapter (#507 validation)', async () => {
    const brief = materializeRetryBrief(CHECKPOINT, RETRY_CONTEXT);
    const reader: BriefFileReader = { readFile: async () => brief };
    const adapter = createLocalBriefAdapter(reader);

    const request = await adapter.resolve({ path: '/tmp/rework.md' });

    expect(request.title).toBe('SCBench calculator — checkpoint 2 (rework)');
    expect(request.brief).toContain(CHECKPOINT.task);
    expect(request.acceptanceCriteria.length).toBeGreaterThanOrEqual(3);
  });
});
