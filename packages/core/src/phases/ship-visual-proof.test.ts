import { describe, expect, it } from 'vitest';

import type { VisualProofResult } from '../checkers/visual-proof.js';
import { recorder } from '../test-support/recording-fakes.test.js';
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
    const log = recorder<[string, string]>();
    const gate = async () => result({ status: 'fail', diagnostic: 'blank' });
    const r = await runVisualProofGate(gate, PR, { log, ciPending: false });
    expect(r.status).toBe('fail');
    expect(log.calls).toEqual([['ship', 'visual proof fail for PR #4 (abcdef012345): blank']]);
  });

  it('still runs the gate while CI is pending and notes it in the log (#4047)', async () => {
    const gate = recorder(async (_pr: typeof PR) => result({ status: 'not-required' }));
    const log = recorder<[string, string]>();
    const r = await runVisualProofGate(gate, PR, { log, ciPending: true });
    expect(gate.calls).toEqual([[PR]]);
    expect(r.status).toBe('not-required');
    expect(log.calls).toEqual([['ship', 'visual proof not-required for PR #4 (abcdef012345) (CI pending)']]);
  });

  it.each([true, false])('turns a gate error into unavailable with CI pending %s (#4047)', async (ciPending) => {
    const gate = () => Promise.reject(new Error('no port'));
    const r = await runVisualProofGate(gate, PR, { log: recorder(), ciPending });
    expect(r).toMatchObject({ status: 'unavailable', headSha: HEAD, diagnostic: 'no port' });
  });

  it('builds a failure reason naming the diagnostic', () => {
    expect(visualProofFailureReason(4, result({ status: 'unavailable', diagnostic: 'no port' }))).toBe(
      'visual proof unavailable for PR #4 at abcdef012345: no port',
    );
  });
});
