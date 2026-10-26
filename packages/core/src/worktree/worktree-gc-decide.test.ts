import { describe, expect, it } from 'vitest';

import { decideLaneRemoval, decideWorktree, type GcDecision } from './worktree-gc-decide.js';
import type { WorktreeEvidence } from './worktree-gc-evidence.js';

type Overrides = Partial<Omit<WorktreeEvidence, 'git'>> & { git?: Partial<WorktreeEvidence['git']> };

function evidence(o: Overrides = {}): WorktreeEvidence {
  const { git, ...rest } = o;
  return {
    path: '/repo-factory-1',
    branch: 'factory/1-x',
    head: 'aaa',
    issue: 1,
    protected: false,
    keep: null,
    ageDays: 0,
    disposition: 'keep',
    existence: 'exists',
    claim: 'claimed',
    prState: 'none',
    ...rest,
    git: {
      clean: true,
      zeroCommit: false,
      priorPush: false,
      remoteBranch: 'present',
      headIsAncestorOfMain: false,
      mainTip: 'bbb',
      unpushedCount: 0,
      untracked: false,
      ...git,
    },
  };
}

const policy = { ttlDays: 7, dryRun: false };
const dry = { ttlDays: 7, dryRun: true };
const rm = (reason: string, branchReapable = false): GcDecision => ({
  action: 'remove',
  reason: reason as never,
  branchReapable,
});
const q = (reason: string): GcDecision => ({ action: 'quarantine', reason: reason as never, branchReapable: false });
const keep = (why: string, held?: string): GcDecision =>
  (held ? { action: 'keep', why, held } : { action: 'keep', why }) as GcDecision;

const rows: Array<[string, Overrides, GcDecision, typeof policy?]> = [
  ['protected', { protected: true, ageDays: 99 }, keep('protected')],
  ['keep-record', { keep: { issue: 1, reason: 'r' }, ageDays: 99 }, keep('keep-record')],
  [
    'keep-record + reap-closed + clean',
    { keep: { issue: 1, reason: 'r' }, disposition: 'reap-closed' },
    rm('issue-closed', true),
  ],
  [
    'keep-record + reap-closed + dirty',
    { keep: { issue: 1, reason: 'r' }, disposition: 'reap-closed', git: { clean: false } },
    keep('keep-record'),
  ],
  ['ttl-expired', { ageDays: 8 }, rm('ttl-expired')],
  [
    'parked + untracked files is held',
    { disposition: 'reap-parked', git: { untracked: true } },
    keep('held-untracked'),
  ],
  [
    'parked + unverifiable untracked probe is held',
    { disposition: 'reap-parked', git: { untracked: null } },
    keep('held-untracked'),
  ],
  [
    'parked + no untracked files is reaped',
    { disposition: 'reap-parked', git: { untracked: false } },
    rm('issue-parked', true),
  ],
  [
    'parked + keep record + untracked still reports keep-record',
    { disposition: 'reap-parked', keep: { issue: 1, reason: 'r' }, git: { untracked: true } },
    keep('keep-record'),
  ],
  [
    'closed + untracked is still reaped',
    { disposition: 'reap-closed', git: { untracked: true } },
    rm('issue-closed', true),
  ],
  [
    'parked + untracked + older than ttl is held, not ttl-expired',
    { disposition: 'reap-parked', ageDays: 99, git: { untracked: true } },
    keep('held-untracked'),
  ],
  ['ttl at the limit', { ageDays: 7 }, keep('no-evidence')],
  ['issue-closed, branch reapable via PR', { disposition: 'reap-closed', prState: 'open' }, rm('issue-closed', true)],
  ['issue-closed, reapable via remote branch', { disposition: 'reap-closed' }, rm('issue-closed', true)],
  [
    'issue-closed, reapable via ancestor',
    { disposition: 'reap-closed', git: { remoteBranch: 'absent', headIsAncestorOfMain: true } },
    rm('issue-closed', true),
  ],
  [
    'issue-parked, not reapable',
    { disposition: 'reap-parked', git: { remoteBranch: 'absent' } },
    rm('issue-parked', false),
  ],
  [
    'issue-closed, detached branch',
    { disposition: 'reap-closed', branch: null, prState: null },
    rm('issue-closed', false),
  ],
  [
    'decomposed: dirty',
    { disposition: 'reap-decomposed', git: { clean: false } },
    keep('held', 'decomposed parent has uncommitted changes'),
  ],
  [
    'decomposed: no head',
    { disposition: 'reap-decomposed', head: null },
    keep('held', 'decomposed parent HEAD could not be resolved'),
  ],
  [
    'decomposed: unpushed unknown',
    { disposition: 'reap-decomposed', git: { unpushedCount: null } },
    keep('held', 'could not verify decomposed parent is pushed'),
  ],
  [
    'decomposed: unpushed commits',
    { disposition: 'reap-decomposed', git: { unpushedCount: 3 } },
    keep('held', 'decomposed parent has 3 unpushed commit(s)'),
  ],
  [
    'decomposed: reap, zero-commit',
    { disposition: 'reap-decomposed', git: { zeroCommit: true } },
    rm('issue-decomposed', true),
  ],
  ['decomposed: reap, has commits', { disposition: 'reap-decomposed' }, rm('issue-decomposed', false)],
  ['decomposed with open PR', { disposition: 'reap-decomposed', prState: 'open' }, keep('no-evidence')],
  ['open PR', { prState: 'open', git: { remoteBranch: 'absent', priorPush: true } }, keep('no-evidence')],
  ['merged', { prState: 'merged' }, rm('merged')],
  ['merged, zero-commit', { prState: 'merged', git: { zeroCommit: true } }, keep('no-evidence')],
  ['merged, dirty', { prState: 'merged', git: { clean: false } }, keep('no-evidence')],
  ['closed, delivered', { prState: 'closed', git: { headIsAncestorOfMain: true } }, rm('merged')],
  [
    'closed, zero-commit',
    { prState: 'closed', git: { zeroCommit: true, headIsAncestorOfMain: true, remoteBranch: 'absent' } },
    keep('no-evidence'),
  ],
  ['closed, remote absent', { prState: 'closed', git: { remoteBranch: 'absent' } }, rm('remote-gone')],
  ['closed, remote present', { prState: 'closed' }, keep('no-evidence')],
  ['local ancestor + push', { git: { headIsAncestorOfMain: true, priorPush: true } }, rm('merged')],
  [
    'head === mainTip, remote present',
    { head: 'bbb', git: { headIsAncestorOfMain: true, priorPush: true } },
    keep('no-evidence'),
  ],
  ['local remote absent + push', { git: { remoteBranch: 'absent', priorPush: true } }, rm('remote-gone')],
  ['remote absent without push', { git: { remoteBranch: 'absent' } }, keep('no-evidence')],
  [
    'ancestor + push, zero-commit',
    { git: { headIsAncestorOfMain: true, priorPush: true, zeroCommit: true } },
    keep('no-evidence'),
  ],
  ['issue-not-found', { existence: 'not-found', claim: 'unknown', disposition: null }, q('issue-not-found')],
  [
    'no-active-claim',
    { prState: 'merged', disposition: 'keep', claim: 'unclaimed', git: { zeroCommit: true } },
    q('no-active-claim'),
  ],
  ['issue-not-found under dry-run', { existence: 'not-found', disposition: null }, keep('no-evidence'), dry],
  [
    'no-active-claim under dry-run',
    { prState: 'merged', claim: 'unclaimed', git: { zeroCommit: true } },
    keep('no-evidence'),
    dry,
  ],
  ['issue-not-found, dirty tree', { existence: 'not-found', git: { clean: false } }, keep('no-evidence')],
  [
    'no-active-claim with merged-claimed issue',
    { prState: 'closed', claim: 'claimed', git: { zeroCommit: true } },
    keep('no-evidence'),
  ],
  [
    'detached branch runs no chain',
    { branch: null, prState: null, git: { remoteBranch: null, headIsAncestorOfMain: true, priorPush: true } },
    keep('no-evidence'),
  ],
  ['detached branch, issue not found', { branch: null, prState: null, existence: 'not-found' }, q('issue-not-found')],
];

describe('decideWorktree', () => {
  it.each(rows)("returns today's outcome and reason for %s", (_name, overrides, expected, pol = policy) => {
    expect(decideWorktree(evidence(overrides), pol)).toEqual(expected);
  });

  const removeRows = rows.filter(
    ([, overrides, expected]) =>
      expected.action !== 'keep' && !overrides.keep && expected.reason !== 'issue-decomposed',
  );

  it.each(removeRows)(
    'keeps a live-claimed worktree over every remove-worthy reason: %s',
    (_name, overrides, _e, pol = policy) => {
      expect(decideWorktree(evidence({ ...overrides, disposition: 'keep-claimed' }), pol)).toEqual(keep('live-claim'));
    },
  );

  it('keeps a live-claimed worktree that is also past its TTL', () => {
    expect(decideWorktree(evidence({ disposition: 'keep-claimed', ageDays: 99 }), policy)).toEqual(keep('live-claim'));
  });
});

describe('decideWorktree with a timed-out remote check (#1627)', () => {
  const held: GcDecision = { action: 'keep', why: 'held', held: 'remote check timed out' };
  const timedOut = { remoteBranch: 'timed-out' as const };

  it('holds a closed-PR clean worktree instead of reaping it as remote-gone', () => {
    expect(decideWorktree(evidence({ prState: 'closed', git: timedOut }), policy)).toEqual(held);
  });

  it('holds a no-PR clean worktree with prior push', () => {
    expect(decideWorktree(evidence({ prState: 'none', git: { ...timedOut, priorPush: true } }), policy)).toEqual(held);
  });

  it('holds rather than quarantining when the issue is not found', () => {
    expect(decideWorktree(evidence({ prState: 'closed', existence: 'not-found', git: timedOut }), policy)).toEqual(
      held,
    );
  });

  it('still reaps a merged PR', () => {
    expect(decideWorktree(evidence({ prState: 'merged', git: timedOut }), policy)).toEqual(rm('merged'));
  });
});

describe('decideLaneRemoval', () => {
  const rec = { issue: 7, reason: 'budget_exceeded' };
  it.each([
    ['keep record, clean tree', rec, true, { action: 'keep', why: 'keep-record' }],
    ['keep record, dirty tree', rec, false, { action: 'keep', why: 'keep-record' }],
    ['keep record, failed probe', rec, null, { action: 'keep', why: 'keep-record' }],
    ['no record, failed probe', null, null, { action: 'keep', why: 'unverified' }],
    ['no record, dirty tree', null, false, { action: 'keep', why: 'dirty' }],
    ['no record, clean tree', null, true, { action: 'remove' }],
  ] as const)('%s', (_name, keepRecord, clean, expected) => {
    expect(decideLaneRemoval({ keep: keepRecord, clean })).toEqual(expected);
  });
});
