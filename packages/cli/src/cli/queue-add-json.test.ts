import { readFileSync } from 'node:fs';
import type { EnqueueResult } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { buildQueueAddJson } from './queue-add-json.js';
import { queueAddJsonSchema } from './json-contract.js';

const labelsFor = (n: number) => ['factory:queued', 'factory:lane:ops', `factory:order:${n}`];

const FIXED: EnqueueResult[] = [
  { issue: 1, outcome: 'queued', position: 3, labelsAdded: labelsFor(3), labelsCreated: ['factory:order:3'] },
  { issue: 2, outcome: 'queued', position: 4, labelsAdded: labelsFor(4), labelsCreated: ['factory:order:4'] },
  { issue: 3, outcome: 'already-queued', position: 1, labelsAdded: [], labelsCreated: [] },
];

describe('buildQueueAddJson', () => {
  it('passes collision through only when set', () => {
    const json = buildQueueAddJson('ops', [
      { issue: 1, outcome: 'queued', position: 25, labelsAdded: [], collision: { order: 24, heldBy: [7] } },
      { issue: 2, outcome: 'queued', position: 26, labelsAdded: [] },
    ]);
    expect(json.issues[0]?.collision).toEqual({ order: 24, heldBy: [7] });
    expect(json.issues[1]).not.toHaveProperty('collision');
    expect(queueAddJsonSchema.parse(json)).toEqual(json);
  });

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
    expect(queueAddJsonSchema.parse(json)).toEqual(json);
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
    expect(queueAddJsonSchema.parse(golden)).toEqual(golden);
  });

  it('validates empty, failed, missing-order, and optional collision forms', () => {
    expect(queueAddJsonSchema.parse(buildQueueAddJson('ops', []))).toMatchObject({ ok: true, issues: [] });
    const result = buildQueueAddJson('ops', [
      { issue: 9, outcome: 'failed', detail: 'boom' },
      { issue: 10, outcome: 'already-queued' },
      { issue: 11, outcome: 'queued', position: 8, collision: { order: 7, heldBy: [4] } },
      { issue: 12, outcome: 'queued', position: 9 },
    ]);
    expect(queueAddJsonSchema.parse(result)).toEqual(result);
    const schema = JSON.parse(
      readFileSync(new URL('../../schemas/queue-add.schema.json', import.meta.url), 'utf-8'),
    ) as object;
    expect(new Ajv2020().compile(schema)(result)).toBe(true);
    expect(result.issues[0]).toMatchObject({ outcome: 'failed', order: null, detail: 'boom' });
    expect(result.issues[1]?.order).toBeNull();
    expect(result.issues[2]?.collision).toEqual({ order: 7, heldBy: [4] });
    expect(result.issues[3]).not.toHaveProperty('collision');
  });
});
