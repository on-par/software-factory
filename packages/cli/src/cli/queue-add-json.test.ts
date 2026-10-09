import { readFileSync } from 'node:fs';
import type { EnqueueResult } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';
import { buildQueueAddJson } from './queue-add-json.js';

const labelsFor = (n: number) => ['factory:queued', 'factory:lane:ops', `factory:order:${n}`];

const FIXED: EnqueueResult[] = [
  { issue: 1, outcome: 'queued', position: 3, labelsAdded: labelsFor(3), labelsCreated: ['factory:order:3'] },
  { issue: 2, outcome: 'queued', position: 4, labelsAdded: labelsFor(4), labelsCreated: ['factory:order:4'] },
  { issue: 3, outcome: 'already-queued', position: 1, labelsAdded: [], labelsCreated: [] },
];

describe('buildQueueAddJson', () => {
  it('builds queued issues with consecutive orders', () => {
    const json = buildQueueAddJson('ops', FIXED.slice(0, 2));
    expect(json.schemaVersion).toBe(1);
    expect(json.action).toBe('queue-add');
    expect(json.ok).toBe(true);
    expect(json.issues.map((i) => i.order)).toEqual([3, 4]);
  });

  it('reports already-queued with its order, or null when unparsable', () => {
    const json = buildQueueAddJson('ops', [
      { issue: 1, outcome: 'already-queued', position: 5, labelsAdded: [] },
      { issue: 2, outcome: 'already-queued' },
    ]);
    expect(json.issues[0]).toEqual({ number: 1, outcome: 'already-queued', order: 5, labelsAdded: [] });
    expect(json.issues[1]?.order).toBeNull();
    expect(json.issues[1]?.labelsAdded).toEqual([]);
  });

  it('marks failures ok:false with detail', () => {
    const json = buildQueueAddJson('ops', [{ issue: 9, outcome: 'failed', detail: 'boom' }]);
    expect(json.ok).toBe(false);
    expect(json.issues[0]).toEqual({ number: 9, outcome: 'failed', order: null, labelsAdded: [], detail: 'boom' });
  });

  it('dedupes labelsCreated in first-seen order', () => {
    const json = buildQueueAddJson('ops', [
      { issue: 1, outcome: 'queued', position: 1, labelsCreated: ['a', 'b'] },
      { issue: 2, outcome: 'queued', position: 2, labelsCreated: ['b', 'c'] },
      { issue: 3, outcome: 'queued', position: 3 },
    ]);
    expect(json.labelsCreated).toEqual(['a', 'b', 'c']);
  });

  it('matches the committed golden sample', () => {
    const golden = JSON.parse(readFileSync(new URL('./__fixtures__/queue-add.json', import.meta.url), 'utf-8'));
    expect(golden).toEqual(buildQueueAddJson('ops', FIXED));
  });
});
