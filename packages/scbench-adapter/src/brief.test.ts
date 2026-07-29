import { createLocalBriefAdapter, type BriefFileReader } from '@on-par/factory-core';
import { describe, expect, it } from 'vitest';

import { materializeBrief } from './brief.js';
import type { ScbenchCheckpoint } from './checkpoint.js';

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
    expect(brief).toContain('- The workspace implements the checkpoint specification above');
  });

  it('round-trips through createLocalBriefAdapter (#507 validation)', async () => {
    const brief = materializeBrief(CHECKPOINT);
    const reader: BriefFileReader = { readFile: async () => brief };
    const adapter = createLocalBriefAdapter(reader);

    const request = await adapter.resolve({ path: '/tmp/checkpoint.md' });

    expect(request.title).toBe('SCBench calculator — checkpoint 2');
    expect(request.brief).toContain(CHECKPOINT.task);
    expect(request.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
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
