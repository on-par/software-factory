import { describe, expect, it, vi } from 'vitest';

import type { VisualProofResult } from '../checkers/visual-proof.js';
import { runVisualProofGate, visualProofFailureReason } from './ship-visual-proof.js';

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const PR = { prNumber: 4, headSha: HEAD };
const result = (patch: Partial<VisualProofResult>): VisualProofResult => ({
  status: 'pass',
  headSha: HEAD,
  runId: 'r',
  captures: [],
  ...patch,
});

describe('runVisualProofGate (#2232)', () => {
  it('returns the gate result and logs status, head and diagnostic', async () => {
    const log = vi.fn();
    const r = await runVisualProofGate(async () => result({ status: 'fail', diagnostic: 'blank' }), PR, {
      log,
      ciPending: false,
    });
    expect(r.status).toBe('fail');
    expect(log).toHaveBeenCalledWith('ship', 'visual proof fail for PR #4 (abcdef012345): blank');
  });

  it('does not start the app or publish anything when proof is not required', async () => {
    const gate = vi.fn(async () => result({ status: 'not-required' }));
    const r = await runVisualProofGate(gate, PR, { log: vi.fn(), ciPending: false });
    expect(r.status).toBe('not-required');
    expect(r.diagnostic).toBeUndefined();
  });

  it('is unavailable without calling the gate while CI is pending', async () => {
    const gate = vi.fn();
    const r = await runVisualProofGate(gate, PR, { log: vi.fn(), ciPending: true });
    expect(gate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: 'unavailable', diagnostic: 'CI pending, visual proof not captured' });
  });

  it('turns a gate error into unavailable', async () => {
    const r = await runVisualProofGate(
      async () => {
        throw new Error('listing files failed');
      },
      PR,
      { log: vi.fn(), ciPending: false },
    );
    expect(r).toMatchObject({ status: 'unavailable', headSha: HEAD, diagnostic: 'listing files failed' });
  });

  it('builds a failure reason naming the diagnostic', () => {
    expect(visualProofFailureReason(4, result({ status: 'unavailable', diagnostic: 'no port' }))).toBe(
      'visual proof unavailable for PR #4 at abcdef012345: no port',
    );
  });
});
