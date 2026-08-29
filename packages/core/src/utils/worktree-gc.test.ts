import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  findCredentialFiles,
  formatGcReport,
  parseWorktreeList,
  scrubFile,
  sweepWorktrees,
  zeroFill,
} from './worktree-gc.js';
import type { SweepDeps } from './worktree-gc.js';

describe('parseWorktreeList', () => {
  it('parses main, branch, and detached worktree entries', () => {
    const porcelain = `worktree /repo/main
HEAD abc123
branch refs/heads/main

worktree /repo/main-factory-ship-it-5
HEAD def456
branch refs/heads/ship-it/5-feature

worktree /repo/main-factory-ship-it-6
HEAD ghi789
detached

`;
    const entries = parseWorktreeList(porcelain);
    expect(entries).toEqual([
      { path: '/repo/main', head: 'abc123', branch: 'main' },
      { path: '/repo/main-factory-ship-it-5', head: 'def456', branch: 'ship-it/5-feature' },
      { path: '/repo/main-factory-ship-it-6', head: 'ghi789', branch: null },
    ]);
  });

  it('tolerates trailing blank lines', () => {
    const porcelain = `worktree /repo/main
HEAD abc123
branch refs/heads/main


`;
    const entries = parseWorktreeList(porcelain);
    expect(entries).toHaveLength(1);
  });
});

describe('findCredentialFiles / zeroFill / scrubFile', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('finds exactly the credential files, zero-fills, and scrubs them', () => {
    dir = mkdtempSync(join(tmpdir(), 'gc-'));
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    writeFileSync(join(dir, '.env.local'), 'SECRET=2');
    writeFileSync(join(dir, '.npmrc'), '//registry/:_authToken=abc');
    writeFileSync(join(dir, '.git-credentials'), 'https://user:pass@github.com');
    mkdirSync(join(dir, '.claude', 'creds'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'creds', 'token.json'), '{"token":"abc"}');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const x = 1;');

    const found = findCredentialFiles(dir).sort();
    const expected = [
      join(dir, '.env'),
      join(dir, '.env.local'),
      join(dir, '.npmrc'),
      join(dir, '.git-credentials'),
      join(dir, '.claude', 'creds', 'token.json'),
    ].sort();
    expect(found).toEqual(expected);

    const envPath = join(dir, '.env');
    const originalSize = statSync(envPath).size;
    zeroFill(envPath);
    const zeroed = readFileSync(envPath);
    expect(zeroed.length).toBe(originalSize);
    expect(zeroed.every((b) => b === 0)).toBe(true);

    scrubFile(envPath);
    expect(existsSync(envPath)).toBe(false);
  });
});

describe('sweepWorktrees', () => {
  let repoRoot: string;
  let parentDir: string;

  function makeWorktree(name: string, ageMs?: number): string {
    const path = join(parentDir, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, '.git'), 'gitdir: /somewhere');
    if (ageMs !== undefined) {
      const past = new Date(Date.now() - ageMs);
      utimesSync(join(path, '.git'), past, past);
    }
    return path;
  }

  afterEach(() => {
    if (parentDir) rmSync(parentDir, { recursive: true, force: true });
  });

  function setup() {
    parentDir = mkdtempSync(join(tmpdir(), 'gc-parent-'));
    repoRoot = join(parentDir, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    return { parentDir, repoRoot };
  }

  it('never issues remove commands for the main worktree or non-factory-named worktrees', async () => {
    setup();
    const otherWorktree = makeWorktree('some-other-worktree');
    const commands: string[] = [];
    const runCommand = async (cmd: string) => {
      commands.push(cmd);
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${repoRoot}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${otherWorktree}\nHEAD bbb\nbranch refs/heads/unrelated\n\n`,
        };
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(0);
    expect(report.kept).toBe(0);
    expect(commands.some((c) => c.includes('worktree remove'))).toBe(false);
    // no factory-managed candidates means resolving origin/main's tip is unnecessary work
    expect(commands.some((c) => c === 'git rev-parse --verify origin/main')).toBe(false);
  });

  it('removes a merged worktree, scrubbing credentials before the remove command runs', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-5`;
    const wt = makeWorktree(wtName);
    writeFileSync(join(wt, '.env'), 'SECRET=1');

    const commands: string[] = [];
    const runCommand = async (cmd: string) => {
      commands.push(cmd);
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/5-feature\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' }; // exit 0 => ancestor => merged
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        return { stdout: 'bbb\n' }; // prior-push evidence
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('merged');
    expect(report.removed[0].scrubbedFiles).toEqual([join(wt, '.env')]);
    expect(existsSync(join(wt, '.env'))).toBe(false);

    const removeIdx = commands.findIndex((c) => c.includes('worktree remove'));
    expect(removeIdx).toBeGreaterThan(-1);
    // credential scrub happens via fs ops before the remove command is issued
    expect(existsSync(join(wt, '.env'))).toBe(false);
    expect(commands.some((c) => c === 'git worktree prune')).toBe(true);
  });

  it('classifies a remote-gone branch when ancestor check fails and ls-remote is empty', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-6`;
    const wt = makeWorktree(wtName);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/6-feature\n\n`,
        };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        throw new Error('exit 1'); // not an ancestor
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: '' }; // empty => remote gone
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        return { stdout: 'bbb\n' }; // prior-push evidence
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('remote-gone');
  });

  it('keeps a fresh worktree with a live remote branch and unmerged head', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-7`;
    const wt = makeWorktree(wtName);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/7-feature\n\n`,
        };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        throw new Error('exit 1');
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: 'bbb\trefs/heads/ship-it/7-feature\n' };
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(0);
    expect(report.kept).toBe(1);
    expect(existsSync(wt)).toBe(true);
  });

  it('classifies ttl-expired worktrees using injected now(), overriding a live branch', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-8`;
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
    const wt = makeWorktree(wtName, eightDaysMs);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/8-feature\n\n`,
        };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        throw new Error('exit 1');
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: 'bbb\trefs/heads/ship-it/8-feature\n' };
      }
      return { stdout: '' };
    };

    const reportExpired = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand, now: () => Date.now() });
    expect(reportExpired.removed).toHaveLength(1);
    expect(reportExpired.removed[0].reason).toBe('ttl-expired');
  });

  it('keeps a worktree within a larger TTL window', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-9`;
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
    const wt = makeWorktree(wtName, eightDaysMs);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/9-feature\n\n`,
        };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        throw new Error('exit 1');
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: 'bbb\trefs/heads/ship-it/9-feature\n' };
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 30 }, { runCommand });
    expect(report.removed).toHaveLength(0);
    expect(report.kept).toBe(1);
  });

  it('dry-run reports candidates without mutating anything', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-10`;
    const wt = makeWorktree(wtName);
    writeFileSync(join(wt, '.env'), 'SECRET=1');

    const commands: string[] = [];
    const runCommand = async (cmd: string) => {
      commands.push(cmd);
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/10-feature\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' };
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        return { stdout: 'bbb\n' }; // prior-push evidence
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7, dryRun: true }, { runCommand });
    expect(report.dryRun).toBe(true);
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].scrubbedFiles).toEqual([]);
    expect(commands.some((c) => c.includes('worktree remove'))).toBe(false);
    expect(commands.some((c) => c === 'git worktree prune')).toBe(false);
    expect(existsSync(join(wt, '.env'))).toBe(true);
  });

  it('falls back to rmSync when git worktree remove fails', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-11`;
    const wt = makeWorktree(wtName);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/11-feature\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' };
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        return { stdout: 'bbb\n' }; // prior-push evidence
      }
      if (cmd.includes('worktree remove')) {
        throw new Error('remove failed');
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(1);
    expect(existsSync(wt)).toBe(false);
  });

  it('keeps a fresh worktree whose HEAD is still origin/main even when --is-ancestor succeeds', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-12`;
    const wt = makeWorktree(wtName);

    const commands: string[] = [];
    const runCommand = async (cmd: string) => {
      commands.push(cmd);
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD aaa\nbranch refs/heads/ship-it/12-feature\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' }; // would resolve as ancestor, but HEAD === tip so this must not fire
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: '' };
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(0);
    expect(report.kept).toBe(1);
    expect(existsSync(wt)).toBe(true);
    expect(commands.some((c) => c.includes('worktree remove'))).toBe(false);
  });

  it('keeps a never-pushed lane created from an older origin/main that is an ancestor of the current tip', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-13`;
    const wt = makeWorktree(wtName);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/13-feature\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'ccc\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' }; // bbb is an ancestor of ccc — still true, but no push evidence
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: '' };
      }
      return { stdout: '' }; // all evidence probes empty
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(0);
    expect(report.kept).toBe(1);
    expect(existsSync(wt)).toBe(true);
  });

  it('keeps every worktree when origin/main cannot be resolved', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-14`;
    const wt = makeWorktree(wtName);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/14-feature\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        throw new Error('no origin/main');
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' };
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: '' };
      }
      return { stdout: '' }; // evidence probes empty
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(0);
    expect(report.kept).toBe(1);
    expect(existsSync(wt)).toBe(true);
  });

  it('keeps a worktree whose .git cannot be stat-ed and logs a warning', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-15`;
    const wt = join(parentDir, wtName);
    mkdirSync(wt, { recursive: true }); // no .git file written — statSync will throw ENOENT

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/15-feature\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        throw new Error('exit 1');
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: 'bbb\trefs/heads/ship-it/15-feature\n' }; // live remote branch
      }
      return { stdout: '' };
    };

    const logs: Array<[string, string]> = [];
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7 },
      { runCommand, log: (type, msg) => logs.push([type, msg]) },
    );
    expect(report.removed).toHaveLength(0);
    expect(report.kept).toBe(1);
    expect(existsSync(wt)).toBe(true);
    expect(logs.some(([type, msg]) => type === 'warn' && msg.includes(join(wt, '.git')))).toBe(true);
  });

  it('keeps a lane parked before SHIP that has commits but was never pushed', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-16`;
    const wt = makeWorktree(wtName);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/16-feature\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        throw new Error('exit 1'); // real commits, not an ancestor
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: '' };
      }
      return { stdout: '' }; // all evidence probes empty
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(0);
    expect(report.kept).toBe(1);
    expect(existsSync(wt)).toBe(true);
  });

  it('still removes a merged lane whose branch was pushed', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-17`;
    const wt = makeWorktree(wtName);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/17-feature\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' };
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        return { stdout: 'bbb\n' };
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('merged');
  });

  it('accepts an origin-ref reflog entry as prior-push evidence for remote-gone', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-18`;
    const wt = makeWorktree(wtName);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/18-feature\n\n`,
        };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        throw new Error('exit 1');
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: '' };
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        throw new Error('no tracking ref');
      }
      if (cmd.startsWith('git reflog show')) {
        return { stdout: 'bbb refs/remotes/origin/ship-it/18-feature@{0}: fetch\n' };
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('remote-gone');
  });

  it('accepts a configured upstream as prior-push evidence for remote-gone', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-19`;
    const wt = makeWorktree(wtName);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/19-feature\n\n`,
        };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        throw new Error('exit 1');
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: '' };
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        throw new Error('no tracking ref');
      }
      if (cmd.startsWith('git reflog show')) {
        return { stdout: '' };
      }
      if (cmd.startsWith('git config --get')) {
        return { stdout: 'refs/heads/ship-it/19-feature\n' };
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('remote-gone');
  });

  it('does not treat the auto-set tracking config from worktree creation as push evidence', async () => {
    // `git worktree add -b <branch> <path> origin/main` auto-sets branch.<branch>.merge to the
    // *start point's* ref (refs/heads/main), not the branch's own ref — that must not be confused
    // with a genuine `git push -u origin <branch>`, which points it at refs/heads/<branch>.
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-20`;
    const wt = makeWorktree(wtName);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/20-feature\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        throw new Error('exit 1'); // real commits, not an ancestor
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: '' }; // never pushed
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        throw new Error('no tracking ref');
      }
      if (cmd.startsWith('git reflog show')) {
        return { stdout: '' };
      }
      if (cmd.startsWith('git config --get')) {
        return { stdout: 'refs/heads/main\n' }; // auto-set from the worktree's start point, not a push
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(0);
    expect(report.kept).toBe(1);
    expect(existsSync(wt)).toBe(true);
  });

  it('never probes for push evidence on a detached worktree', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-21`;
    const wt = makeWorktree(wtName);

    const commands: string[] = [];
    const runCommand = async (cmd: string) => {
      commands.push(cmd);
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\ndetached\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' }; // would be an ancestor, but there is no branch to attribute a push to
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(0);
    expect(report.kept).toBe(1);
    expect(
      commands.some(
        (c) =>
          c.includes('rev-parse --verify --quiet') || c.includes('git config --get') || c.startsWith('git reflog show'),
      ),
    ).toBe(false);
  });

  it('deletes the branch of a merged worktree after git worktree prune', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-30`;
    const wt = makeWorktree(wtName);

    const commands: string[] = [];
    const runCommand = async (cmd: string) => {
      commands.push(cmd);
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/30-feature\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' }; // exit 0 => ancestor => merged
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        return { stdout: 'bbb\n' }; // prior-push evidence
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('merged');
    expect(report.removed[0].branchDeleted).toBe(true);

    const pruneIdx = commands.indexOf('git worktree prune');
    const branchDeleteIdx = commands.indexOf("git branch -D 'ship-it/30-feature'");
    expect(pruneIdx).toBeGreaterThan(-1);
    expect(branchDeleteIdx).toBeGreaterThan(pruneIdx);
  });

  it('deletes the branch of a remote-gone worktree', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-31`;
    const wt = makeWorktree(wtName);

    const commands: string[] = [];
    const runCommand = async (cmd: string) => {
      commands.push(cmd);
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/31-feature\n\n`,
        };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        throw new Error('exit 1'); // not an ancestor
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: '' }; // empty => remote gone
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        return { stdout: 'bbb\n' }; // prior-push evidence
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('remote-gone');
    expect(report.removed[0].branchDeleted).toBe(true);

    const pruneIdx = commands.indexOf('git worktree prune');
    const branchDeleteIdx = commands.indexOf("git branch -D 'ship-it/31-feature'");
    expect(pruneIdx).toBeGreaterThan(-1);
    expect(branchDeleteIdx).toBeGreaterThan(pruneIdx);
  });

  it('keeps the branch of a ttl-expired worktree', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-32`;
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
    const wt = makeWorktree(wtName, eightDaysMs);

    const commands: string[] = [];
    const runCommand = async (cmd: string) => {
      commands.push(cmd);
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/32-feature\n\n`,
        };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        throw new Error('exit 1');
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: 'bbb\trefs/heads/ship-it/32-feature\n' };
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand, now: () => Date.now() });
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('ttl-expired');
    expect(report.removed[0].branchDeleted).toBe(false);
    expect(commands.some((c) => c.startsWith('git branch -D'))).toBe(false);
  });

  it('warns and does not fail the sweep when git branch -D fails', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-33`;
    const wt = makeWorktree(wtName);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/33-feature\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' };
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        return { stdout: 'bbb\n' };
      }
      if (cmd.startsWith('git branch -D')) {
        throw new Error('branch is checked out');
      }
      return { stdout: '' };
    };

    const logs: Array<[string, string]> = [];
    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7 },
      { runCommand, log: (type, msg) => logs.push([type, msg]) },
    );
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('merged');
    expect(report.removed[0].branchDeleted).toBe(false);
    expect(logs.some(([type, msg]) => type === 'warn' && /git branch -D failed/.test(msg))).toBe(true);
  });
});

describe('sweepWorktrees with GitHub PR evidence', () => {
  let repoRoot: string;
  let parentDir: string;

  function makeWorktree(name: string): string {
    const path = join(parentDir, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, '.git'), 'gitdir: /somewhere');
    return path;
  }

  function setup() {
    parentDir = mkdtempSync(join(tmpdir(), 'gc-parent-'));
    repoRoot = join(parentDir, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    return { parentDir, repoRoot };
  }

  afterEach(() => {
    if (parentDir) rmSync(parentDir, { recursive: true, force: true });
  });

  /** The only endpoint sweepWorktrees reaches (resolvePrState → rest.pulls.list). A structural
   *  supertype of Pick<Octokit,'rest'>, so widening it costs one assertion, never a chain. */
  interface SweepOctokitDouble {
    rest: { pulls: { list: (args: any) => Promise<any> } };
  }

  function asSweepOctokit(double: SweepOctokitDouble): NonNullable<SweepDeps['octokit']> {
    return double as NonNullable<SweepDeps['octokit']>;
  }

  function fakeOctokit(
    result: () => Promise<{ data: Array<Record<string, unknown>> }> | { data: Array<Record<string, unknown>> },
  ) {
    const pullsList = vi.fn(async (_params: unknown) => result());
    const octokit = asSweepOctokit({ rest: { pulls: { list: pullsList } } });
    return { octokit, pullsList };
  }

  it('removes a worktree whose branch has a merged PR on GitHub with zero local push evidence', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-21`;
    const wt = makeWorktree(wtName);

    const { octokit, pullsList } = fakeOctokit(async () => ({
      data: [{ number: 1, state: 'closed', merged_at: '2026-08-14T00:00:00Z' }],
    }));
    const commands: string[] = [];
    const runCommand = async (cmd: string) => {
      commands.push(cmd);
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/21-merged\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (
        cmd.includes('rev-parse --verify --quiet') ||
        cmd.startsWith('git reflog show') ||
        cmd.startsWith('git config --get')
      ) {
        throw new Error('no local evidence'); // today's sound-buddy state: no ref, no reflog, merge stuck on refs/heads/main
      }
      return { stdout: '' }; // git status --porcelain --untracked-files=no => clean
    };

    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'on-par/sound-buddy' },
      { runCommand, octokit },
    );
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('merged');
    expect(pullsList).toHaveBeenCalledWith({
      owner: 'on-par',
      repo: 'sound-buddy',
      state: 'all',
      head: 'on-par:ship-it/21-merged',
    });
    expect(
      commands.some(
        (c) =>
          c.includes('rev-parse --verify --quiet') ||
          c.startsWith('git reflog show') ||
          c.startsWith('git config --get'),
      ),
    ).toBe(false);
  });

  it('keeps a worktree whose branch has an open PR even when local evidence would say merged', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-22`;
    const wt = makeWorktree(wtName);

    const { octokit } = fakeOctokit(async () => ({ data: [{ number: 1, state: 'open' }] }));
    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/22-open\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        return { stdout: 'bbb\n' }; // tracking-ref evidence present — the old code would have removed
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'on-par/sound-buddy' },
      { runCommand, octokit },
    );
    expect(report.removed).toHaveLength(0);
    expect(report.kept).toBe(1);
    expect(existsSync(wt)).toBe(true);
  });

  it('removes a closed-not-merged PR worktree when the remote branch is gone', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-23`;
    const wt = makeWorktree(wtName);

    const { octokit } = fakeOctokit(async () => ({ data: [{ number: 1, state: 'closed', merged_at: null }] }));
    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/23-closed\n\n`,
        };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        throw new Error('exit 1'); // not an ancestor
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: '' }; // empty => remote gone
      }
      return { stdout: '' }; // status probe => clean
    };

    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'on-par/sound-buddy' },
      { runCommand, octokit },
    );
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('remote-gone');
  });

  it('keeps a closed-not-merged PR worktree while the remote branch is still live', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-24`;
    const wt = makeWorktree(wtName);

    const { octokit } = fakeOctokit(async () => ({ data: [{ number: 1, state: 'closed', merged_at: null }] }));
    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/24-live\n\n`,
        };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        throw new Error('exit 1');
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: 'xxx\trefs/heads/ship-it/24-live\n' }; // live upstream
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'on-par/sound-buddy' },
      { runCommand, octokit },
    );
    expect(report.removed).toHaveLength(0);
    expect(report.kept).toBe(1);
    expect(existsSync(wt)).toBe(true);
  });

  it('removes a closed-not-merged PR worktree whose HEAD is an ancestor of origin/main', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-25`;
    const wt = makeWorktree(wtName);

    const { octokit } = fakeOctokit(async () => ({ data: [{ number: 1, state: 'closed', merged_at: null }] }));
    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/25-delivered\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'bbb\n' }; // HEAD bbb is the tip — delivered
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' }; // ancestor => delivered
      }
      return { stdout: '' }; // status probe => clean
    };

    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'on-par/sound-buddy' },
      { runCommand, octokit },
    );
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('merged');
  });

  it('falls back to local evidence and still removes merged when the GitHub query throws', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-26`;
    const wt = makeWorktree(wtName);

    const { octokit } = fakeOctokit(async () => {
      throw new Error('rate limited');
    });
    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/26-x\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' }; // ancestor
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        return { stdout: 'bbb\n' }; // tracking-ref evidence
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'on-par/sound-buddy' },
      { runCommand, octokit },
    );
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('merged');
  });

  it('falls back to local evidence when no PR exists for the branch', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-27`;
    const wt = makeWorktree(wtName);

    const { octokit } = fakeOctokit(async () => ({ data: [] }));
    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/27-x\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' };
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        return { stdout: 'bbb\n' };
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'on-par/sound-buddy' },
      { runCommand, octokit },
    );
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('merged');
  });

  it('keeps a GitHub-merged worktree with uncommitted tracked changes', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-28`;
    const wt = makeWorktree(wtName);

    const { octokit } = fakeOctokit(async () => ({
      data: [{ number: 1, state: 'closed', merged_at: '2026-08-14T00:00:00Z' }],
    }));
    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/28-dirty\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git status --porcelain')) {
        return { stdout: ' M ship.ts\n' }; // dirty — live work
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'on-par/sound-buddy' },
      { runCommand, octokit },
    );
    expect(report.removed).toHaveLength(0);
    expect(report.kept).toBe(1);
    expect(existsSync(wt)).toBe(true);
  });

  it('keeps a GitHub-merged worktree when the cleanliness probe itself fails', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-28b`;
    const wt = makeWorktree(wtName);

    const { octokit } = fakeOctokit(async () => ({
      data: [{ number: 1, state: 'closed', merged_at: '2026-08-14T00:00:00Z' }],
    }));
    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/28b-x\n\n`,
        };
      }
      if (cmd.startsWith('git status --porcelain')) {
        throw new Error('probe failed'); // cannot prove clean ⇒ keep
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees(
      { repoRoot: root, ttlDays: 7, repo: 'on-par/sound-buddy' },
      { runCommand, octokit },
    );
    expect(report.removed).toHaveLength(0);
    expect(report.kept).toBe(1);
    expect(existsSync(wt)).toBe(true);
  });

  it('uses local evidence when octokit is present but no repo is given', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-28c`;
    const wt = makeWorktree(wtName);

    const { octokit, pullsList } = fakeOctokit(async () => ({
      data: [{ number: 1, state: 'closed', merged_at: '2026-08-14T00:00:00Z' }],
    }));
    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/28c-x\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' }; // ancestor
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        return { stdout: 'bbb\n' }; // tracking-ref evidence
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand, octokit });
    expect(pullsList).not.toHaveBeenCalled();
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('merged');
  });

  it('keeps a dirty worktree on the local fallback path', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-29`;
    const wt = makeWorktree(wtName);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return {
          stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/29-dirty\n\n`,
        };
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return { stdout: 'aaa\n' };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' }; // ancestor
      }
      if (cmd.includes('rev-parse --verify --quiet')) {
        return { stdout: 'bbb\n' }; // tracking-ref evidence
      }
      if (cmd.startsWith('git status --porcelain')) {
        return { stdout: ' M ship.ts\n' }; // dirty — live work
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(0);
    expect(report.kept).toBe(1);
    expect(existsSync(wt)).toBe(true);
  });
});

describe('formatGcReport', () => {
  it('formats a dry-run report', () => {
    const text = formatGcReport({
      dryRun: true,
      kept: 2,
      removed: [
        {
          path: '/repo/foo-factory-ship-it-1',
          branch: 'ship-it/1-x',
          ageDays: 3.2,
          reason: 'merged',
          scrubbedFiles: [],
          branchDeleted: false,
        },
      ],
    });
    expect(text).toContain('/repo/foo-factory-ship-it-1 (ship-it/1-x, 3d old) — merged');
    expect(text).toContain('would remove 1 worktree(s), kept 2');
  });

  it('formats a real removal report with scrubbed file counts', () => {
    const text = formatGcReport({
      dryRun: false,
      kept: 0,
      removed: [
        {
          path: '/repo/foo-factory-ship-it-2',
          branch: null,
          ageDays: 10,
          reason: 'ttl-expired',
          scrubbedFiles: ['/repo/foo-factory-ship-it-2/.env'],
          branchDeleted: false,
        },
      ],
    });
    expect(text).toContain(
      '/repo/foo-factory-ship-it-2 (detached, 10d old) — ttl-expired, scrubbed 1 credential file(s)',
    );
    expect(text).toContain('removed 1 worktree(s), kept 0');
  });

  it('renders a deleted-branch suffix when branchDeleted is true', () => {
    const text = formatGcReport({
      dryRun: false,
      kept: 0,
      removed: [
        {
          path: '/repo/foo-factory-ship-it-3',
          branch: 'ship-it/3-x',
          ageDays: 1,
          reason: 'merged',
          scrubbedFiles: [],
          branchDeleted: true,
        },
      ],
    });
    expect(text).toContain('/repo/foo-factory-ship-it-3 (ship-it/3-x, 1d old) — merged, deleted branch ship-it/3-x');
  });

  it('omits the deleted-branch suffix when branchDeleted is false', () => {
    const text = formatGcReport({
      dryRun: false,
      kept: 0,
      removed: [
        {
          path: '/repo/foo-factory-ship-it-4',
          branch: 'ship-it/4-x',
          ageDays: 1,
          reason: 'ttl-expired',
          scrubbedFiles: [],
          branchDeleted: false,
        },
      ],
    });
    expect(text).not.toContain('deleted branch');
  });
});
