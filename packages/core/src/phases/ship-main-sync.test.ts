import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { recorder } from '../test-support/recording-fakes.test.js';
import { syncShipBranchWithMain } from './ship-main-sync.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function changelog(added: string[]): string {
  return `# Changelog\n\n## Unreleased\n\n### Added\n\n${added.map((l) => `- ${l}\n`).join('')}\n## 0.9.0 - 2026-01-01\n\n- old (#1)\n`;
}
function commit(repo: string, files: Record<string, string>, message: string): void {
  for (const [file, text] of Object.entries(files)) writeFileSync(join(repo, file), text);
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', message);
}
const run = async (command: string, options?: { cwd?: string }) => ({
  stdout: execSync(command, { cwd: options?.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  stderr: '',
});

function conflictingLane(): { lane: string; checked: string } {
  const root = tempDirs.makeSync('ship-main-sync-');
  const origin = join(root, 'origin.git');
  const main = join(root, 'main');
  const lane = join(root, 'lane');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  mkdirSync(main, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', main]);
  for (const repo of [main]) {
    git(repo, 'config', 'user.name', 'Factory Test');
    git(repo, 'config', 'user.email', 'factory@example.test');
  }
  mkdirSync(join(main, 'docs/adr'), { recursive: true });
  writeFileSync(join(main, 'docs/adr/README.md'), readFileSync(join(process.cwd(), 'docs/adr/README.md'), 'utf8'));
  commit(main, { 'CHANGELOG.md': changelog(['base (#2)']) }, 'initial');
  git(main, 'remote', 'add', 'origin', origin);
  git(main, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-b', 'main', origin, lane]);
  git(lane, 'config', 'user.name', 'Factory Test');
  git(lane, 'config', 'user.email', 'factory@example.test');
  git(lane, 'checkout', '-b', 'factory/3-topic');
  commit(lane, { 'CHANGELOG.md': changelog(['lane work (#3)', 'base (#2)']), 'lane.txt': 'x\n' }, 'lane');
  commit(main, { 'CHANGELOG.md': changelog(['sibling (#4)', 'base (#2)']) }, 'sibling');
  git(main, 'push', 'origin', 'main');
  return { lane, checked: git(lane, 'rev-parse', 'HEAD') };
}

describe('syncShipBranchWithMain merges origin/main before SHIP pushes, because GitHub runs no pull_request CI on a PR left conflicting by sibling merges, so syncing first opens it mergeable and CI runs', () => {
  it('merges origin/main into a branch whose only conflict is CHANGELOG Unreleased, keeping both bullets', async () => {
    const { lane, checked } = conflictingLane();
    const log = recorder<[string, string]>();
    const result = await syncShipBranchWithMain({ run, worktree: lane, branch: 'factory/3-topic', log });
    expect(result.checkedSha).toBe(checked);
    expect(git(lane, 'rev-parse', 'HEAD')).not.toBe(checked);
    expect(git(lane, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD')).toBe('');
    const text = readFileSync(join(lane, 'CHANGELOG.md'), 'utf8');
    expect(text).toContain('- sibling (#4)');
    expect(text).toContain('- lane work (#3)');
    expect(text).not.toMatch(/^(<{7}|={7}|>{7})/m);
    expect(log.calls).toContainEqual(['ship', expect.stringContaining('merged origin/main into factory/3-topic')]);
  });

  it('ships unsynced and says so when the sync cannot finish', async () => {
    const log = recorder<[string, string]>();
    const fakeRun = async () => ({ stdout: 'abc123\n', stderr: '' });
    const sync = async () => ({
      ok: false as const,
      message: 'unresolved merge conflicts: src/a.ts',
      paths: [],
    });
    const result = await syncShipBranchWithMain({ run: fakeRun, worktree: '/w', branch: 'b', log, sync });
    expect(result).toEqual({ checkedSha: 'abc123' });
    expect(log.calls).toContainEqual([
      'ship',
      'could not sync b with origin/main before push (unresolved merge conflicts: src/a.ts); pushing it unsynced',
    ]);
  });

  it('never throws when git itself fails', async () => {
    const log = recorder<[string, string]>();
    const fakeRun = async () => {
      throw new Error('git missing');
    };
    await expect(syncShipBranchWithMain({ run: fakeRun, worktree: '/w', branch: 'b', log })).resolves.toEqual({
      checkedSha: undefined,
    });
    expect(log.calls).toContainEqual(['ship', expect.stringContaining('(git missing); pushing it unsynced')]);
  });

  it('logs nothing about a merge when the branch is already up to date', async () => {
    const log = recorder<[string, string]>();
    const fakeRun = async () => ({ stdout: 'same\n', stderr: '' });
    const sync = async () => ({ ok: true as const });
    await syncShipBranchWithMain({ run: fakeRun, worktree: '/w', branch: 'b', log, sync });
    expect(log.calls).toEqual([]);
  });
});
