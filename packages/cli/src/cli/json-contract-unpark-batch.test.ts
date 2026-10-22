import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { unparkBatchJsonSchema, unparkJsonSchema } from './json-contract.js';
import { unparkClient } from './test-support/unpark-client.js';
import { runUnparkBatch, toUnparkBatchJson } from './unpark.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/json/${name}`, import.meta.url), 'utf-8')) as unknown;

describe('unpark batch JSON contract (#3331)', () => {
  it('validates a runUnparkBatch envelope against the batch schema and the single-item schema', async () => {
    const labels = new Map<number, string[]>([
      [1, ['factory:parked', 'factory:lane:ops']],
      [2, ['bug']],
      [3, ['factory:parked', 'factory:lane:ops']],
    ]);
    const outcome = await runUnparkBatch({
      owner: 'on-par',
      repo: 'example',
      issues: [1, 2, 3],
      client: unparkClient(labels),
      readIssueBody: async () => '',
      listBlockedBy: async () => [],
    });
    if (outcome.kind !== 'done') throw new Error('expected done');
    const envelope = toUnparkBatchJson(outcome);
    expect(unparkBatchJsonSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.summary).toEqual({ ok: 2, failed: 1 });
    for (const item of envelope.results.filter((r) => r.ok)) {
      expect(unparkJsonSchema.parse(item)).toEqual(item);
      expect(Object.keys(item).sort()).toEqual(Object.keys(unparkJsonSchema.parse(item)).sort());
    }
    const golden = fixture('unpark-batch.json') as Record<string, unknown>;
    expect(unparkBatchJsonSchema.safeParse({ ...golden, summary: 'x' }).success).toBe(false);
    expect(
      unparkBatchJsonSchema.safeParse({ ...golden, results: [{ ...(envelope.results[0] as object), ok: 'yes' }] })
        .success,
    ).toBe(false);
  });
});
