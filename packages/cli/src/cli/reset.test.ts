import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LaneFileGuard, ReworkHistory } from '@on-par/factory-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatResetLine, parseResetIssues, type ResetDeps, runReset } from './reset.js';

let root: string;
let repo: string;
let wt192: string;

const sh = (cmd: string, cwd = repo) => execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' });

function seedState() {
  const state = join(repo, '.factory', 'state');
  for (const d of ['plans', 'runs', join('logs', 'issue-192')]) mkdirSync(join(state, d), { recursive: true });
  for (const f of ['issue-192.md', 'issue-192.design.json', 'issue-192.design.md']) {
    writeFileSync(join(state, 'plans', f), 'x');
  }
  writeFileSync(join(state, 'runs', 'issue-192.phase.json'), '{}');
  writeFileSync(join(state, 'logs', 'issue-192', 'x.log'), 'x');
  return state;
}

function makeDeps(state: string, over: Partial<ResetDeps> = {}) {
  const releaseLease = vi.fn(async () => {});
  const deps: ResetDeps = {
    repoRoot: repo,
    cwd: repo,
    paths: {
      plans: join(state, 'plans'),
      runs: join(state, 'runs'),
      logs: join(state, 'logs'),
      reworkHistory: join(state, 'rework-history.json'),
      laneFiles: join(state, 'lane-files.json'),
    },
    git: async (cmd) => sh(cmd),
    removeWorktree: async (p) => {
      sh(`git worktree remove --force '${p}'`);
      sh('git worktree prune');
    },
    readLeases: () => [{ worktreeId: wt192, branch: 'ship-it/192-some-title', port: 3100, pid: 1, acquiredAt: 'now' }],
    releaseLease,
    ...over,
  };
  return { deps, releaseLease };
}

async function seedHistory(state: string) {
  const h = new ReworkHistory(join(state, 'rework-history.json'));
  await h.record(192, 'sig-192', ['tests']);
  await h.record(7, 'sig-7', ['tests']);
  await new LaneFileGuard(join(state, 'lane-files.json')).register('o/r', 192, ['a.ts']);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'reset-test-')));
  repo = join(root, 'repo');
  mkdirSync(repo);
  sh(
    'git init -q -b main && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init',
  );
  wt192 = join(root, 'wt-192');
  sh(`git worktree add -q -b ship-it/192-some-title '${wt192}'`);
  sh('git branch factory/193-other');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('runReset', () => {
  it('removes every piece of local state for the issue and nothing else', async () => {
    const state = seedState();
    await seedHistory(state);
    const { deps, releaseLease } = makeDeps(state);

    await runReset([192], deps);

    expect(existsSync(wt192)).toBe(false);
    expect(sh('git branch --list "ship-it/192-*"').trim()).toBe('');
    expect(sh('git branch --list "factory/193-*"')).toContain('factory/193-other');
    expect(readdirSafe(join(state, 'plans'))).toEqual([]);
    expect(existsSync(join(state, 'runs', 'issue-192.phase.json'))).toBe(false);
    expect(existsSync(join(state, 'logs', 'issue-192'))).toBe(false);
    expect(releaseLease).toHaveBeenCalledWith(wt192);
    const history = new ReworkHistory(join(state, 'rework-history.json'));
    expect(await history.priorSignature(192)).toBeUndefined();
    expect(await history.priorSignature(7)).toBe('sig-7');
    expect(await new LaneFileGuard(join(state, 'lane-files.json')).findCollision('o/r', 1, ['a.ts'])).toBeUndefined();
  });

  it('prints one summary line per issue', async () => {
    const state = seedState();
    await seedHistory(state);
    const { deps } = makeDeps(state);

    const lines = await runReset([192, 555], deps);

    expect(lines).toHaveLength(2);
    for (const part of [
      '#192: removed worktree',
      'branch ship-it/192-some-title',
      'plan files (3)',
      'phase file',
      'rework history',
      'logs',
      'lane-file claim',
      'port lease',
      '; kept nothing',
    ]) {
      expect(lines[0]).toContain(part);
    }
    expect(lines[1]).toBe('#555: nothing to reset');
  });

  it('keeps the worktree and branch when cwd is inside the worktree', async () => {
    const state = seedState();
    const { deps, releaseLease } = makeDeps(state, { cwd: join(wt192, 'sub') });

    const [line] = await runReset([192], deps);

    expect(line).toContain(`kept worktree ${wt192} (current checkout)`);
    expect(line).toContain('branch ship-it/192-some-title (checked out in');
    expect(existsSync(wt192)).toBe(true);
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it('reports a failing removal as kept and carries on', async () => {
    const state = seedState();
    const { deps } = makeDeps(state, {
      removeWorktree: async () => {
        throw new Error('boom');
      },
    });

    const [line] = await runReset([192], deps);

    expect(line).toContain(`kept worktree ${wt192} (boom)`);
    expect(line).toContain('plan files (3)');
  });

  it('matches the resolved branch prefix', async () => {
    const state = seedState();
    const { deps } = makeDeps(state, { branchPrefix: 'factory', readLeases: () => [] });

    const [line] = await runReset([193], deps);

    expect(line).toContain('branch factory/193-other');
    expect(sh('git branch --list "factory/193-*"').trim()).toBe('');
  });
});

describe('runReset failure reporting', () => {
  it('reports git failures as kept and never throws', async () => {
    const state = seedState();
    const { deps } = makeDeps(state, {
      git: async () => {
        throw new Error('git down');
      },
      readLeases: () => {
        throw new Error('lease read');
      },
    });

    const [line] = await runReset([192], deps);

    expect(line).toContain('kept worktrees (git worktree list failed: git down)');
    expect(line).toContain('branches (git down)');
    expect(line).toContain('port leases (lease read)');
  });

  it('reports a failing branch delete and lease release as kept', async () => {
    const state = seedState();
    const { deps } = makeDeps(state, {
      git: async (cmd) => {
        if (cmd.includes('branch -D')) throw new Error('locked');
        return sh(cmd);
      },
      releaseLease: async () => {
        throw new Error('busy');
      },
    });

    const [line] = await runReset([192], deps);

    expect(line).toContain('kept branch ship-it/192-some-title (locked)');
    expect(line).toContain('port lease 3100 (busy)');
  });

  it('reports plan and phase files that cannot be removed as kept', async () => {
    const state = seedState();
    const { deps } = makeDeps(state);
    // A directory where a file is expected makes rmSync (non-recursive) throw EISDIR.
    rmSync(join(state, 'plans', 'issue-192.md'));
    mkdirSync(join(state, 'plans', 'issue-192.md'));
    rmSync(join(state, 'runs', 'issue-192.phase.json'));
    mkdirSync(join(state, 'runs', 'issue-192.phase.json'));

    const [line] = await runReset([192], deps);

    expect(line).toContain('kept');
    expect(line).toMatch(/plan files \(/);
    expect(line).toMatch(/phase file \(/);
  });
});

describe('parseResetIssues', () => {
  it('dedupes in order and rejects non-issue values', () => {
    expect(parseResetIssues(['12', '12', '3'])).toEqual([12, 3]);
    for (const bad of ['abc', '0', '-1']) expect(() => parseResetIssues([bad])).toThrow('is not an issue number');
  });
});

describe('formatResetLine', () => {
  it('formats nothing, removed-only and removed+kept', () => {
    expect(formatResetLine({ issue: 1, removed: [], kept: [] })).toBe('#1: nothing to reset');
    expect(formatResetLine({ issue: 1, removed: ['logs'], kept: [] })).toBe('#1: removed logs; kept nothing');
    expect(formatResetLine({ issue: 1, removed: ['logs'], kept: ['branch b (x)'] })).toBe(
      '#1: removed logs; kept branch b (x)',
    );
    expect(formatResetLine({ issue: 1, removed: [], kept: ['branch b (x)'] })).toBe(
      '#1: removed nothing; kept branch b (x)',
    );
  });
});

function readdirSafe(dir: string): string[] {
  return existsSync(dir) ? execSync(`ls '${dir}'`, { encoding: 'utf-8' }).split('\n').filter(Boolean) : [];
}
