import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { landResultJsonSchema } from './land-result-contract.js';

const base = { schemaVersion: 1, pr: 7, headSha: 'abc', mergeable: 'MERGEABLE' };

describe('landResultJsonSchema', () => {
  it('accepts each of the five result results', () => {
    const results = [
      { ...base, result: 'merged' },
      { ...base, result: 'checks_pending', pending: ['build'] },
      { ...base, result: 'checks_failed', failed: [] },
      { ...base, result: 'conflicting', mergeable: 'CONFLICTING' },
      { ...base, result: 'closed', headSha: null, mergeable: 'UNKNOWN' },
    ];
    for (const variant of results) expect(landResultJsonSchema.parse(variant)).toEqual(variant);
  });

  it('rejects checks_pending without pending', () => {
    expect(landResultJsonSchema.safeParse({ ...base, result: 'checks_pending' }).success).toBe(false);
  });

  it('validates the golden fixture', () => {
    const raw = readFileSync(join(import.meta.dirname, '__fixtures__', 'json', 'land-result.json'), 'utf-8');
    expect(landResultJsonSchema.parse(JSON.parse(raw)).result).toBe('checks_pending');
  });
});
