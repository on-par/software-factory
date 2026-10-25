// packages/cli/src/cli/run-lane-restack.test.ts — runLane's restack step (ADR-0161)

import { describe, expect, it } from 'vitest';

import './index.js';
import { restackUnderHeartbeat } from './run-lane-restack.js';

const merged = { index: 1, prNumber: 9 };

describe('restackUnderHeartbeat', () => {
  it('parks with the reason when the restack parks', async () => {
    const out = await restackUnderHeartbeat(
      7,
      undefined,
      async () => ({ status: 'park', reason: 'conflict', index: 2, files: [] }),
      merged,
    );
    expect(out).toEqual({ parkReason: 'conflict', note: 'conflict' });
  });

  it('describes restacked slices', async () => {
    const out = await restackUnderHeartbeat(
      7,
      undefined,
      async () => ({ status: 'restacked', slices: [{ index: 2 }, { index: 3 }] }) as never,
      merged,
    );
    expect(out).toEqual({ note: 'restacked slice(s) 2, 3 onto main after slice 1 merged' });
  });

  it('turns a thrown restack into a park reason', async () => {
    const out = await restackUnderHeartbeat(7, undefined, async () => Promise.reject(new Error('boom')), merged);
    expect(out.parkReason).toContain('restack failed');
    expect(out.note).toBe(out.parkReason);
  });
});
