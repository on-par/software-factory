import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_FILING_POLICY } from '../filing/policy.js';
import { BlockerFilingError, type BlockerRefusalReason, type fileBlocker } from './file-blocker.js';
import { runBlockerTrigger } from './trigger.js';

const claim = { title: 'Add storage', problem: 'Storage is missing', inScope: ['a'], acceptance: ['b'] };
const parent = { number: 10, title: 'Add export endpoint', body: 'Export data as CSV.' };
const base = { octokit: {} as never, repo: 'o/r', parent, claim, phase: 'plan' as const };
const filer = (impl: () => ReturnType<typeof fileBlocker>) => vi.fn(impl);

describe('runBlockerTrigger', () => {
  it('maps filed to blocked', async () => {
    const file = filer(async () => ({ outcome: 'filed', number: 11 }));
    const out = await runBlockerTrigger({ ...base, file });
    expect(out).toEqual({
      reason: 'blocked',
      message: 'blocked by #11 (Add storage) — filed from PLAN',
      blockers: [11],
    });
  });

  it('maps existing to blocked', async () => {
    const out = await runBlockerTrigger({ ...base, file: filer(async () => ({ outcome: 'existing', number: 12 })) });
    expect(out).toMatchObject({ reason: 'blocked', blockers: [12] });
    expect(out.message).toContain('existing blocker #12');
  });

  it('maps duplicate to blocked on the existing sub-issue', async () => {
    const file = filer(async () => ({ outcome: 'duplicate', number: 13, title: 'Storage', similarity: 0.9 }));
    const out = await runBlockerTrigger({ ...base, phase: 'build', file });
    expect(out).toMatchObject({ reason: 'blocked', blockers: [13] });
    expect(out.message).toContain('open sub-issue #13 (Storage)');
  });

  it('maps a max-blockers-reached refusal to held with the reason', async () => {
    const file = filer(async () => {
      throw new BlockerFilingError('max-blockers-reached', 'already 3');
    });
    const out = await runBlockerTrigger({ ...base, file });
    expect(out).toEqual({
      reason: 'held',
      message: 'blocker filing refused (max-blockers-reached): already 3',
      blockers: [],
    });
  });

  it.each<BlockerRefusalReason>([
    'invalid-claim',
    'parent-is-blocker',
    'daily-cap-reached',
    'listing-unverified',
    'create-failed',
  ])('maps %s to held', async (reason) => {
    const file = filer(async () => {
      throw new BlockerFilingError(reason, 'nope');
    });
    const out = await runBlockerTrigger({ ...base, file });
    expect(out).toMatchObject({ reason: 'held', blockers: [] });
    expect(out.message).toContain(reason);
  });

  it('lists the child on a link-failed refusal', async () => {
    const file = filer(async () => {
      throw new BlockerFilingError('link-failed', 'x', 14);
    });
    expect(await runBlockerTrigger({ ...base, file })).toMatchObject({ reason: 'held', blockers: [14] });
  });

  it('maps unexpected throws to held', async () => {
    const err = await runBlockerTrigger({
      ...base,
      file: filer(async () => {
        throw new Error('boom');
      }),
    });
    expect(err).toEqual({ reason: 'held', message: 'blocker filing refused (error): boom', blockers: [] });
    const str = await runBlockerTrigger({
      ...base,
      file: filer(async () => {
        throw 'weird';
      }),
    });
    expect(str.message).toBe('blocker filing refused (error): weird');
  });

  it('escalates without filing when the claim restates the parent', async () => {
    const file = filer(async () => ({ outcome: 'filed', number: 1 }));
    const out = await runBlockerTrigger({ ...base, claim: { ...claim, title: 'add export endpoint' }, file });
    expect(out.reason).toBe('escalate');
    expect(out.message).toContain('plan escalated: invalid BLOCKED_BY claim');
    expect(file).not.toHaveBeenCalled();
  });

  it('passes the default policy and an injected clock to the filer', async () => {
    const file = filer(async () => ({ outcome: 'filed', number: 11 }));
    const now = () => new Date(0);
    await runBlockerTrigger({ ...base, file, now });
    expect(file).toHaveBeenCalledWith(
      expect.objectContaining({ parent: 10, policy: { maxPerDay: DEFAULT_FILING_POLICY.maxPerDay }, now }),
    );
    await runBlockerTrigger({ ...base, file, policy: { maxPerDay: 1 } });
    expect(file).toHaveBeenLastCalledWith(expect.objectContaining({ policy: { maxPerDay: 1 } }));
  });
});
