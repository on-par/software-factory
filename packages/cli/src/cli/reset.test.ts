import { execSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
    runCommand: async (cmd, o) => ({ stdout: sh(cmd, o?.cwd ?? repo) }),
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
    'git init -q -b main && git config user.email t@t && git config user.name t && echo x > a.txt && git add a.txt && git commit -q -m init',
  );
  sh(`git init -q --bare '${join(root, 'origin.git')}'`);
  sh(`git remote add origin '${join(root, 'origin.git')}' && git push -q origin main`);
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

describe('runReset state-write failures', () => {
  it('reports rework-history and lane-file registries that cannot be rewritten as kept', async () => {
    const state = seedState();
    await seedHistory(state);
    // A directory squatting on the registry's tmp file makes the rewrite throw.
    mkdirSync(join(state, 'rework-history.json.tmp'));
    mkdirSync(join(state, 'lane-files.json.tmp'));
    const { deps } = makeDeps(state);

    const [line] = await runReset([192], deps);

    expect(line).toMatch(/kept .*rework history \(/);
    expect(line).toMatch(/lane-file claim \(/);
  });
});

describe('runReset logs failure', () => {
  it('reports a logs dir that cannot be removed as kept', async () => {
    const state = seedState();
    const { deps } = makeDeps(state);
    const logsDir = join(state, 'logs');
    // Removing an entry needs write permission on its parent directory.
    chmodSync(logsDir, 0o500);
    try {
      const [line] = await runReset([192], deps);
      // Running as root bypasses the permission check, so only assert when the removal failed.
      if (existsSync(join(logsDir, 'issue-192'))) expect(line).toMatch(/logs \(/);
    } finally {
      chmodSync(logsDir, 0o700);
    }
  });
});

describe('parseResetIssues', () => {
  it('dedupes in order and rejects non-issue values', () => {
    expect(parseResetIssues(['12', '12', '3'])).toEqual([12, 3]);
    for (const bad of ['abc', '0', '-1']) expect(() => parseResetIssues([bad])).toThrow('is not an issue number');
  });
});

describe('runReset --dry-run', () => {
  const readOr = (f: string) => (existsSync(f) ? readFileSync(f, 'utf-8') : '');
  const snapshot = (state: string) => ({
    worktrees: sh('git worktree list --porcelain'),
    refs: sh('git for-each-ref refs/heads/'),
    plans: readdirSafe(join(state, 'plans')),
    phase: existsSync(join(state, 'runs', 'issue-192.phase.json')),
    logs: existsSync(join(state, 'logs', 'issue-192', 'x.log')),
    history: readOr(join(state, 'rework-history.json')),
    claims: readOr(join(state, 'lane-files.json')),
  });

  it('lists every item it would remove and changes nothing', async () => {
    const state = seedState();
    await seedHistory(state);
    const cmds: string[] = [];
    const removeWorktree = vi.fn(async () => {});
    const { deps, releaseLease } = makeDeps(state, {
      dryRun: true,
      removeWorktree,
      git: async (cmd) => {
        cmds.push(cmd);
        return sh(cmd);
      },
    });
    const before = snapshot(state);

    const [line] = await runReset([192], deps);

    expect(line.startsWith('#192 (dry run): would remove')).toBe(true);
    for (const part of [
      `worktree ${wt192}`,
      'branch ship-it/192-some-title',
      `plan file ${join(state, 'plans', 'issue-192.md')}`,
      `plan file ${join(state, 'plans', 'issue-192.design.json')}`,
      `plan file ${join(state, 'plans', 'issue-192.design.md')}`,
      `phase file ${join(state, 'runs', 'issue-192.phase.json')}`,
      `logs ${join(state, 'logs', 'issue-192')}`,
      'rework history entry #192',
      'lane-file claim o/r#192',
      'port lease 3100',
      'would keep nothing',
    ]) {
      expect(line).toContain(part);
    }
    expect(snapshot(state)).toEqual(before);
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
    expect(cmds.some((c) => c.includes('branch -D'))).toBe(false);
  });

  it('reports the current checkout as would-keep', async () => {
    const state = seedState();
    const { deps } = makeDeps(state, { dryRun: true, cwd: join(wt192, 'sub') });

    const [line] = await runReset([192], deps);

    expect(line).toContain(`would keep worktree ${wt192} (current checkout)`);
    expect(line).toContain('branch ship-it/192-some-title (checked out in');
  });

  it('prints nothing to reset for an unknown issue', async () => {
    const { deps } = makeDeps(seedState(), { dryRun: true });
    expect(await runReset([555], deps)).toEqual(['#555 (dry run): nothing to reset']);
  });
});

describe('formatResetLine', () => {
  it('formats the dry-run shapes', () => {
    expect(formatResetLine({ issue: 1, removed: [], kept: [], dryRun: true })).toBe('#1 (dry run): nothing to reset');
    expect(formatResetLine({ issue: 1, removed: ['logs x'], kept: [], dryRun: true })).toBe(
      '#1 (dry run): would remove logs x; would keep nothing',
    );
    expect(formatResetLine({ issue: 1, removed: [], kept: ['b'], dryRun: true })).toBe(
      '#1 (dry run): would remove nothing; would keep b',
    );
  });

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

describe('runReset safety (#1789)', () => {
  it('keeps a dirty worktree and its branch, still removes other state', async () => {
    const state = seedState();
    writeFileSync(join(wt192, 'a.txt'), 'changed');
    const { deps, releaseLease } = makeDeps(state);
    const [line] = await runReset([192], deps);
    expect(existsSync(wt192)).toBe(true);
    expect(sh('git branch --list ship-it/192-some-title')).not.toBe('');
    expect(existsSync(join(state, 'plans', 'issue-192.md'))).toBe(false);
    expect(existsSync(join(state, 'logs', 'issue-192'))).toBe(false);
    expect(releaseLease).not.toHaveBeenCalled();
    expect(line).toContain(`kept worktree ${wt192} (uncommitted changes; pass --force to remove)`);
  });

  it('keeps a worktree with unpushed commits', async () => {
    const state = seedState();
    sh('git commit -q --allow-empty -m wip', wt192);
    const { deps } = makeDeps(state);
    const [line] = await runReset([192], deps);
    expect(existsSync(wt192)).toBe(true);
    expect(sh('git branch --list ship-it/192-some-title')).not.toBe('');
    expect(line).toContain('1 unpushed commit(s); pass --force to remove');
    expect(existsSync(join(state, 'plans', 'issue-192.md'))).toBe(false);
  });

  it('keeps an unpushed branch that has no worktree', async () => {
    const state = seedState();
    const extra = join(root, 'wt-extra');
    sh(`git worktree add -q -b ship-it/192-extra '${extra}'`);
    sh('git commit -q --allow-empty -m extra', extra);
    sh(`git worktree remove --force '${extra}'`);
    const { deps } = makeDeps(state);
    const [line] = await runReset([192], deps);
    expect(line).toContain('branch ship-it/192-extra (1 unpushed commit(s); pass --force to remove)');
    expect(sh('git branch --list ship-it/192-extra')).not.toBe('');
  });

  it('keeps a worktree whose HEAD is unresolvable as unverifiable', async () => {
    const state = seedState();
    const { deps } = makeDeps(state, {
      runCommand: async () => {
        throw new Error('boom');
      },
    });
    const [line] = await runReset([192], deps);
    expect(line).toContain('(uncommitted changes; pass --force to remove)');
  });

  it('--force removes dirty and unpushed worktrees and branches', async () => {
    const state = seedState();
    sh('git commit -q --allow-empty -m wip', wt192);
    writeFileSync(join(wt192, 'a.txt'), 'changed');
    const { deps } = makeDeps(state, { force: true });
    const [line] = await runReset([192], deps);
    expect(existsSync(wt192)).toBe(false);
    expect(sh('git branch --list ship-it/192-some-title')).toBe('');
    expect(line).not.toContain('kept worktree');
  });

  it('--dry-run reports would-keep for a dirty worktree', async () => {
    const state = seedState();
    writeFileSync(join(wt192, 'a.txt'), 'changed');
    const { deps } = makeDeps(state, { dryRun: true });
    const [line] = await runReset([192], deps);
    expect(line).toContain(`would keep worktree ${wt192} (uncommitted changes`);
    expect(existsSync(wt192)).toBe(true);
  });

  it('keeps when the unpushed count cannot be parsed', async () => {
    const state = seedState();
    const { deps } = makeDeps(state, {
      runCommand: async (cmd, o) => ({ stdout: cmd.includes('rev-list') ? 'nope' : sh(cmd, o?.cwd ?? repo) }),
    });
    const [line] = await runReset([192], deps);
    expect(line).toContain('could not verify it is pushed; pass --force to remove');
  });
});
