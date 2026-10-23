import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { upsertIndexRow } from '@on-par/adr-kit';

import { createTempDirs } from '../harness/temp-dir.js';
import { syncLandBranch } from './sync.js';

const tempDirs = createTempDirs();
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function writeAdr(repo: string, file: string, number: string, title: string): void {
  mkdirSync(join(repo, 'docs/adr'), { recursive: true });
  writeFileSync(
    join(repo, 'docs/adr', file),
    `# ADR-${number}: ${title}\n\n- Status: Accepted\n\n## Context\n\nText.\n`,
  );
}
function fixture(): { root: string; main: string; lane: string; origin: string } {
  const root = tempDirs.makeSync('land-sync-');
  const origin = join(root, 'origin.git');
  const main = join(root, 'main');
  const lane = join(root, 'lane');
  // Pin the branch: the runner's init.defaultBranch may be master, and a clone of a bare repo whose
  // HEAD names a missing branch checks out nothing.
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  mkdirSync(main, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', main]);
  git(main, 'config', 'user.name', 'Factory Test');
  git(main, 'config', 'user.email', 'factory@example.test');
  mkdirSync(join(main, 'docs/adr'), { recursive: true });
  writeFileSync(join(main, 'docs/adr/README.md'), readFileSync(join(process.cwd(), 'docs/adr/README.md'), 'utf8'));
  writeAdr(main, '0001-base.md', '0001', 'Base');
  git(main, 'add', '.');
  git(main, 'commit', '-m', 'initial');
  git(main, 'remote', 'add', 'origin', origin);
  git(main, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-b', 'main', origin, lane]);
  git(lane, 'config', 'user.name', 'Factory Test');
  git(lane, 'config', 'user.email', 'factory@example.test');
  git(lane, 'checkout', '-b', 'lane/topic');
  return { root, main, lane, origin };
}

afterEach(() => tempDirs.cleanup());

describe('syncLandBranch', () => {
  it('resolves an ADR index only conflict, preserves both rows, and pushes a merge commit', async () => {
    const { main, lane, origin } = fixture();
    writeAdr(main, '0002-main.md', '0002', 'Main addition');
    const mainReadme = readFileSync(join(main, 'docs/adr/README.md'), 'utf8');
    const mainBaseEdit = upsertIndexRow(mainReadme, {
      number: 1,
      title: 'Base row changed by main',
      status: 'Accepted',
      href: '0001-boss-worker-checker-pipeline.md',
    });
    writeFileSync(
      join(main, 'docs/adr/README.md'),
      upsertIndexRow(mainBaseEdit, { number: 2, title: 'Main addition', status: 'Accepted', href: '0002-main.md' }),
    );
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'main ADR');
    git(main, 'push', 'origin', 'main');
    writeAdr(lane, '0003-lane.md', '0003', 'Lane addition');
    const laneReadme = readFileSync(join(lane, 'docs/adr/README.md'), 'utf8');
    const laneBaseEdit = upsertIndexRow(laneReadme, {
      number: 1,
      title: 'Base row changed by lane',
      status: 'Accepted',
      href: '0001-boss-worker-checker-pipeline.md',
    });
    writeFileSync(
      join(lane, 'docs/adr/README.md'),
      upsertIndexRow(laneBaseEdit, { number: 3, title: 'Lane addition', status: 'Accepted', href: '0003-lane.md' }),
    );
    git(lane, 'add', '.');
    git(lane, 'commit', '-m', 'lane ADR');
    git(lane, 'push', '-u', 'origin', 'lane/topic');
    const events: unknown[] = [];
    const commands: string[] = [];
    const run = async (command: string, options?: { cwd?: string }) => {
      commands.push(command);
      return {
        stdout: execSync(command, { cwd: options?.cwd ?? lane, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
        stderr: '',
      };
    };
    const result = await syncLandBranch({
      worktree: lane,
      branch: 'lane/topic',
      run,
      log: (...args) => events.push(args),
    });
    expect(result).toEqual({ ok: true });
    const readme = readFileSync(join(lane, 'docs/adr/README.md'), 'utf8');
    expect(readme).toContain('0002-main.md');
    expect(readme).toContain('0003-lane.md');
    const localHead = git(lane, 'rev-parse', 'HEAD');
    expect(git(origin, 'rev-parse', 'refs/heads/lane/topic')).toBe(localHead);
    expect(git(lane, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    expect(events).toContainEqual([
      'conflict_resolved',
      'resolved ADR index conflict mechanically',
      { mode: 'mechanical', paths: ['docs/adr/README.md'] },
    ]);
    const prettier = join(process.cwd(), 'node_modules/.bin/prettier');
    execFileSync(prettier, ['--check', join(lane, 'docs/adr/README.md')], { cwd: process.cwd() });
    expect(commands.some((command) => command.includes('--force'))).toBe(false);
  });

  it('aborts a mixed ADR-index and source conflict and reports the unresolved source path', async () => {
    const { main, lane } = fixture();
    writeAdr(main, '0002-main.md', '0002', 'Main addition');
    writeFileSync(
      join(main, 'docs/adr/README.md'),
      '# ADRs\n\n| Number | Title | Status |\n| --- | --- | --- |\n| [0002](0002-main.md) | Main addition | Accepted |\n\n',
    );
    writeFileSync(join(main, 'source.txt'), 'main\n');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'main source');
    git(main, 'push', 'origin', 'main');
    writeAdr(lane, '0003-lane.md', '0003', 'Lane addition');
    writeFileSync(
      join(lane, 'docs/adr/README.md'),
      '# ADRs\n\n| Number | Title | Status |\n| --- | --- | --- |\n| [0003](0003-lane.md) | Lane addition | Accepted |\n\n',
    );
    writeFileSync(join(lane, 'source.txt'), 'lane\n');
    git(lane, 'add', '.');
    git(lane, 'commit', '-m', 'lane source');
    git(lane, 'push', '-u', 'origin', 'lane/topic');
    const before = git(lane, 'rev-parse', 'HEAD');
    const events: unknown[] = [];
    const run = async (command: string, options?: { cwd?: string }) => ({
      stdout: execSync(command, { cwd: options?.cwd ?? lane, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    });
    const result = await syncLandBranch({
      worktree: lane,
      branch: 'lane/topic',
      run,
      log: (...args) => events.push(args),
    });
    expect(result).toEqual({
      ok: false,
      message: 'unresolved merge conflicts: source.txt',
      paths: ['source.txt'],
      conflict: true,
    });
    expect(git(lane, 'rev-parse', 'HEAD')).toBe(before);
    expect(() => git(lane, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow();
    expect(events).toContainEqual([
      'conflict_detected',
      'land sync conflicts: docs/adr/README.md, source.txt',
      { paths: ['docs/adr/README.md', 'source.txt'] },
    ]);
    expect(events.some((event) => Array.isArray(event) && event[0] === 'conflict_resolved')).toBe(false);
  });
});
