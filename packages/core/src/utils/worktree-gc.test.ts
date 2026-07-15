import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import {
  parseWorktreeList,
  findCredentialFiles,
  scrubFile,
  zeroFill,
  sweepWorktrees,
  formatGcReport,
} from './worktree-gc.js';

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
    expect(zeroed.every(b => b === 0)).toBe(true);

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
    expect(commands.some(c => c.includes('worktree remove'))).toBe(false);
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
        return { stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/5-feature\n\n` };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' }; // exit 0 => ancestor => merged
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7 }, { runCommand });
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].reason).toBe('merged');
    expect(report.removed[0].scrubbedFiles).toEqual([join(wt, '.env')]);
    expect(existsSync(join(wt, '.env'))).toBe(false);

    const removeIdx = commands.findIndex(c => c.includes('worktree remove'));
    expect(removeIdx).toBeGreaterThan(-1);
    // credential scrub happens via fs ops before the remove command is issued
    expect(existsSync(join(wt, '.env'))).toBe(false);
    expect(commands.some(c => c === 'git worktree prune')).toBe(true);
  });

  it('classifies a remote-gone branch when ancestor check fails and ls-remote is empty', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-6`;
    const wt = makeWorktree(wtName);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return { stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/6-feature\n\n` };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        throw new Error('exit 1'); // not an ancestor
      }
      if (cmd.startsWith('git ls-remote')) {
        return { stdout: '' }; // empty => remote gone
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
        return { stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/7-feature\n\n` };
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
        return { stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/8-feature\n\n` };
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
        return { stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/9-feature\n\n` };
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
        return { stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/10-feature\n\n` };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' };
      }
      return { stdout: '' };
    };

    const report = await sweepWorktrees({ repoRoot: root, ttlDays: 7, dryRun: true }, { runCommand });
    expect(report.dryRun).toBe(true);
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].scrubbedFiles).toEqual([]);
    expect(commands.some(c => c.includes('worktree remove'))).toBe(false);
    expect(commands.some(c => c === 'git worktree prune')).toBe(false);
    expect(existsSync(join(wt, '.env'))).toBe(true);
  });

  it('falls back to rmSync when git worktree remove fails', async () => {
    const { repoRoot: root } = setup();
    const wtName = `${basename(root)}-factory-ship-it-11`;
    const wt = makeWorktree(wtName);

    const runCommand = async (cmd: string) => {
      if (cmd === 'git worktree list --porcelain') {
        return { stdout: `worktree ${root}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/ship-it/11-feature\n\n` };
      }
      if (cmd.startsWith('git merge-base --is-ancestor')) {
        return { stdout: '' };
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
});

describe('formatGcReport', () => {
  it('formats a dry-run report', () => {
    const text = formatGcReport({
      dryRun: true,
      kept: 2,
      removed: [
        { path: '/repo/foo-factory-ship-it-1', branch: 'ship-it/1-x', ageDays: 3.2, reason: 'merged', scrubbedFiles: [] },
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
        },
      ],
    });
    expect(text).toContain('/repo/foo-factory-ship-it-2 (detached, 10d old) — ttl-expired, scrubbed 1 credential file(s)');
    expect(text).toContain('removed 1 worktree(s), kept 0');
  });
});
