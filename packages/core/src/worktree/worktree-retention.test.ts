import { describe, expect, it } from 'vitest';

import { quarantineRoot } from './worktree-gc.js';
import type { WorktreeEvidence } from './worktree-gc-evidence.js';
import {
  reclaimRetainedWorktrees,
  resolveRetentionPolicy,
  retentionCandidateOf,
  selectRetentionEvictions,
  type RetentionCandidate,
} from './worktree-retention.js';

const REPO = '/tmp/retention-fake/repo';
const NO_KEEPS = '/tmp/retention-fake/no-keeps.json';

function evidence(over: Partial<WorktreeEvidence> = {}, git: Partial<WorktreeEvidence['git']> = {}): WorktreeEvidence {
  return {
    path: '/tmp/x/repo-factory-1',
    branch: 'factory/1-a',
    head: 'abc',
    issue: 1,
    protected: false,
    keep: null,
    ageDays: 1,
    disposition: 'keep',
    existence: 'exists',
    claim: 'unclaimed',
    prState: 'open',
    git: {
      clean: true,
      zeroCommit: false,
      priorPush: true,
      remoteBranch: 'present',
      headIsAncestorOfMain: false,
      mainTip: 'tip',
      unpushedCount: 0,
      untracked: false,
      ...git,
    },
    ...over,
  };
}

const NONE: ReadonlySet<number> = new Set();

function cand(path: string, ageDays: number, over: Partial<RetentionCandidate> = {}): RetentionCandidate {
  return { path, branch: 'factory/1-a', issue: 1, ageDays, kind: 'finished', protectedBy: null, why: null, ...over };
}

describe('selectRetentionEvictions', () => {
  it('evicts the oldest eligible trees until the count is within budget', () => {
    const all = [cand('/a', 1), cand('/b', 5), cand('/c', 3), cand('/d', 9)];
    const sel = selectRetentionEvictions(all, { maxRetained: 2 });
    expect(sel.retained).toBe(4);
    expect(sel.target).toBe(2);
    expect(sel.evict.map((c) => c.path)).toEqual(['/d', '/b']);
  });

  it('orders ties by path so selection is deterministic', () => {
    const all = [cand('/z', 4), cand('/m', 4), cand('/a', 4), cand('/q', 4)];
    const expected = selectRetentionEvictions(all, { maxRetained: 1 }).evict.map((c) => c.path);
    expect(expected).toEqual(['/a', '/m', '/q']);
    for (const shuffled of [[...all].reverse(), [all[2], all[0], all[3], all[1]]]) {
      expect(selectRetentionEvictions(shuffled, { maxRetained: 1 }).evict.map((c) => c.path)).toEqual(expected);
    }
  });

  it('evicts nothing at or under budget, or when the count budget is off', () => {
    const all = [cand('/a', 1), cand('/b', 2)];
    expect(selectRetentionEvictions(all, { maxRetained: 2 }).evict).toEqual([]);
    expect(selectRetentionEvictions(all, { maxRetained: 0 }).evict).toEqual([]);
  });

  it('never selects a protected tree even under disk pressure', () => {
    const guarded = cand('/p', 99, { protectedBy: 'unrecoverable', why: 'uncommitted changes' });
    const sel = selectRetentionEvictions([guarded, cand('/a', 1)], { maxRetained: 8 }, { pressure: true });
    expect(sel.target).toBe(0);
    expect(sel.evict.map((c) => c.path)).toEqual(['/a']);
    expect(sel.protected).toEqual([guarded]);
  });
});

describe('resolveRetentionPolicy', () => {
  it('reads worktree.retainMax', () => {
    expect(resolveRetentionPolicy({ worktree: { retainMax: 3 } } as never)).toEqual({ maxRetained: 3 });
  });
});

describe('retentionCandidateOf', () => {
  it('marks an open-PR tree pr-backed and eligible when fully pushed', () => {
    const c = retentionCandidateOf(evidence(), { rebuildIssues: NONE });
    expect(c).toMatchObject({ kind: 'pr-backed', protectedBy: null, why: null });
  });

  it('protects a tree with unpushed commits and reports the reason', () => {
    const c = retentionCandidateOf(evidence({}, { unpushedCount: 2 }), { rebuildIssues: NONE });
    expect(c).toMatchObject({ protectedBy: 'unrecoverable', why: '2 unpushed commit(s)' });
  });

  it('protects dirty, untracked, unverifiable and remote-absent trees with a reason', () => {
    const why = (e: WorktreeEvidence): string | null => retentionCandidateOf(e, { rebuildIssues: NONE }).why;
    expect(why(evidence({}, { clean: false }))).toBe('uncommitted changes');
    expect(why(evidence({}, { untracked: true }))).toBe('untracked files');
    expect(why(evidence({}, { untracked: null }))).toBe('untracked probe failed');
    expect(why(evidence({ branch: null }))).toBe('detached HEAD');
    expect(why(evidence({ head: null }))).toBe('HEAD could not be resolved');
    expect(why(evidence({}, { unpushedCount: null }))).toBe('could not verify pushed');
    expect(why(evidence({}, { remoteBranch: 'absent' }))).toBe('origin branch absent');
    expect(why(evidence({}, { remoteBranch: 'timed-out' }))).toBe('remote check timed out');
    expect(why(evidence({}, { remoteBranch: null }))).toBe('remote check failed');
  });

  it('protects active-claim and conflict-rebuild trees', () => {
    const by = (e: WorktreeEvidence, rebuildIssues: ReadonlySet<number> = NONE): string | null =>
      retentionCandidateOf(e, { rebuildIssues }).protectedBy;
    expect(by(evidence({ protected: true }))).toBe('active-claim');
    expect(by(evidence({ protected: true, branch: 'factory/1-a-rebuild' }))).toBe('conflict-rebuild');
    expect(by(evidence({ disposition: 'keep-claimed' }))).toBe('active-claim');
    expect(by(evidence({ branch: 'factory/1-a-rebuild' }))).toBe('conflict-rebuild');
    expect(by(evidence(), new Set([1]))).toBe('conflict-rebuild');
    expect(by(evidence({ keep: { issue: 1, reason: 'debugging' } }))).toBe('keep-record');
  });
});

interface Fake {
  calls: string[];
  logs: string[];
  run: (cmd: string, opts?: { cwd?: string }) => Promise<{ stdout: string }>;
  log: (kind: string, msg: string) => void;
}

function fake(paths: Array<{ path: string; branch: string; dirty?: boolean }>, extraEntries = ''): Fake {
  const calls: string[] = [];
  const logs: string[] = [];
  const porcelain =
    `worktree ${REPO}\nHEAD m\nbranch refs/heads/main\n\n` +
    paths.map((p) => `worktree ${p.path}\nHEAD abc\nbranch refs/heads/${p.branch}\n`).join('\n') +
    extraEntries;
  return {
    calls,
    logs,
    log: (kind, msg) => logs.push(`${kind}: ${msg}`),
    run: async (cmd, opts) => {
      calls.push(cmd);
      if (cmd.startsWith('git worktree list')) return { stdout: porcelain };
      if (cmd.startsWith('git ls-remote')) return { stdout: 'sha\trefs/heads/x\n' };
      if (cmd.startsWith('git rev-list --count') && cmd.includes('--not')) return { stdout: '0\n' };
      if (cmd.startsWith('git status --porcelain')) {
        const dirty = paths.find((p) => p.path === opts?.cwd)?.dirty === true;
        return { stdout: dirty && cmd.includes('untracked-files=normal') ? '?? junk\n' : '' };
      }
      return { stdout: '' };
    },
  };
}

const trees = [
  { path: '/tmp/retention-fake/repo-factory-1', branch: 'factory/1-a' },
  { path: '/tmp/retention-fake/repo-factory-2', branch: 'factory/2-b' },
  { path: '/tmp/retention-fake/repo-factory-3', branch: 'factory/3-c' },
];

function reclaim(f: Fake, over: { maxRetained?: number; pressure?: boolean; protectedIssues?: Set<number> } = {}) {
  return reclaimRetainedWorktrees(
    {
      repoRoot: REPO,
      policy: { maxRetained: over.maxRetained ?? 0 },
      pressure: over.pressure,
      protectedIssues: over.protectedIssues,
      keepsFile: NO_KEEPS,
    },
    { runCommand: f.run, log: f.log, now: () => 0 },
  );
}

describe('reclaimRetainedWorktrees', () => {
  it('removes only the worktree directory and keeps the local branch', async () => {
    const f = fake(trees);
    const report = await reclaim(f, { maxRetained: 1 });
    expect(report.evicted).toHaveLength(2);
    expect(f.calls.filter((c) => c.startsWith('git worktree remove --force'))).toHaveLength(2);
    expect(f.calls.some((c) => c.includes('branch -D'))).toBe(false);
    expect(f.calls.at(-1)).toBe('git worktree prune');
    expect(f.logs.filter((l) => l.includes('retention: evicted'))).toHaveLength(2);
  });

  it('returns early without evidence probes at or under budget', async () => {
    const f = fake(trees);
    const report = await reclaim(f, { maxRetained: 3 });
    expect(report.evict).toEqual([]);
    expect(f.calls).toEqual(['git worktree list --porcelain']);
  });

  it('logs a worktree-gc event naming each protected tree and its reason', async () => {
    const f = fake([trees[0], { ...trees[1], dirty: true }, trees[2]]);
    const report = await reclaim(f, { pressure: true, protectedIssues: new Set([3]) });
    expect(report.evicted.map((c) => c.issue)).toEqual([1]);
    expect(f.logs).toContain(
      'worktree-gc: retention: kept /tmp/retention-fake/repo-factory-2 (#2) — unrecoverable: untracked files',
    );
    expect(f.logs.some((l) => l.includes('(#3) — active-claim'))).toBe(true);
  });

  it('skips quarantined worktrees', async () => {
    const quarantined = `${quarantineRoot(REPO)}/repo-factory-9`;
    const f = fake([trees[0], { path: quarantined, branch: 'factory/9-q' }]);
    const report = await reclaim(f, { pressure: true });
    expect(report.retained).toBe(1);
    expect(report.evicted.map((c) => c.path)).toEqual([trees[0].path]);
    expect(f.calls.some((c) => c.includes('repo-factory-9'))).toBe(false);
  });

  it('records a removal failure and never deletes a branch', async () => {
    const f = fake(trees.slice(0, 1));
    const failing = {
      ...f,
      run: async (cmd: string, opts?: { cwd?: string }) => {
        if (cmd.startsWith('git worktree remove')) throw new Error('boom');
        return f.run(cmd, opts);
      },
    };
    const report = await reclaim(failing, { pressure: true });
    // rmSync fallback of a non-existent path succeeds, so the tree counts as evicted.
    expect(report.evicted).toHaveLength(1);
    expect(f.logs.some((l) => l.includes('git worktree remove failed'))).toBe(true);
  });
});
