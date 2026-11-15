import { describe, expect, it } from 'vitest';

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
    const logged: Array<[string, string]> = [];
    const r = await runVisualProofGate(async () => result({ status: 'fail', diagnostic: 'blank' }), PR, {
      log: (level, msg) => logged.push([level, msg]),
      ciPending: false,
    });
    expect(r.status).toBe('fail');
    expect(logged).toEqual([['ship', 'visual proof fail for PR #4 (abcdef012345): blank']]);
  });

  it('does not start the app or publish anything when proof is not required', async () => {
    const gate = async () => result({ status: 'not-required' });
    const r = await runVisualProofGate(gate, PR, { log: () => undefined, ciPending: false });
    expect(r.status).toBe('not-required');
    expect(r.diagnostic).toBeUndefined();
  });

  it('still runs the gate while CI is pending and notes it in the log (#4047)', async () => {
    const gateInputs: unknown[] = [];
    const gate = async (input: typeof PR) => {
      gateInputs.push(input);
      return result({ status: 'not-required' });
    };
    const logged: Array<[string, string]> = [];
    const r = await runVisualProofGate(gate, PR, { log: (level, msg) => logged.push([level, msg]), ciPending: true });
    expect(gateInputs).toEqual([PR]);
    expect(r.status).toBe('not-required');
    expect(logged).toEqual([['ship', 'visual proof not-required for PR #4 (abcdef012345) (CI pending)']]);
  });

  it('turns a gate error into unavailable while CI is pending (#4047)', async () => {
    const r = await runVisualProofGate(
      async () => {
        throw new Error('no port');
      },
      PR,
      { log: () => undefined, ciPending: true },
    );
    expect(r).toMatchObject({ status: 'unavailable', headSha: HEAD, diagnostic: 'no port' });
  });

  it('turns a gate error into unavailable', async () => {
    const r = await runVisualProofGate(
      async () => {
        throw new Error('listing files failed');
      },
      PR,
      { log: () => undefined, ciPending: false },
    );
    expect(r).toMatchObject({ status: 'unavailable', headSha: HEAD, diagnostic: 'listing files failed' });
  });

  it('builds a failure reason naming the diagnostic', () => {
    expect(visualProofFailureReason(4, result({ status: 'unavailable', diagnostic: 'no port' }))).toBe(
      'visual proof unavailable for PR #4 at abcdef012345: no port',
    );
  });
});
