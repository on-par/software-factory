import { describe, expect, it } from 'vitest';

import { registerCommandOutputSink, withCommandOutputScope } from '../command-output/capture.js';
import { defaultExecFn } from './exec.js';

describe('harness exec capture exclusion (#3994)', () => {
  it('harness exec inside a capture scope emits no records', async () => {
    const records: unknown[] = [];
    const unregister = registerCommandOutputSink((r) => records.push(r));
    try {
      await withCommandOutputScope({ runId: 'r', issue: 'gh:3', lane: 'l', phase: 'check' }, async () => {
        await defaultExecFn('node -e "console.log(1)"', {});
      });
    } finally {
      unregister();
    }
    expect(records).toEqual([]);
  });
});
