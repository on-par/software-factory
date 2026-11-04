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

const RELEASED = '## 0.9.0 - 2026-01-01\n\n### Added\n\n- old (#1)\n';
function changelog(added: string[], released = RELEASED): string {
  return `# Changelog\n\n## Unreleased\n\n### Added\n\n${added.map((l) => `- ${l}\n`).join('')}\n${released}`;
}
function seedChangelog(f: ReturnType<typeof fixture>, attributes = false): void {
  writeFileSync(join(f.main, 'CHANGELOG.md'), changelog(['base (#2)']));
  if (attributes) writeFileSync(join(f.main, '.gitattributes'), 'CHANGELOG.md merge=union\n');
  git(f.main, 'add', '.');
  git(f.main, 'commit', '-m', 'changelog');
  git(f.main, 'push', 'origin', 'main');
  git(f.lane, 'pull', '--ff-only', 'origin', 'main');
}
function commitIn(repo: string, files: Record<string, string>, push: string): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), text);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'change');
  git(repo, 'push', '-u', 'origin', push);
}
function localRun(lane: string) {
  return async (command: string, options?: { cwd?: string }) => ({
    stdout: execSync(command, { cwd: options?.cwd ?? lane, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  });
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
    expect(result).toEqual({ ok: false, message: 'unresolved merge conflicts: source.txt', paths: ['source.txt'] });
    expect(git(lane, 'rev-parse', 'HEAD')).toBe(before);
    expect(() => git(lane, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow();
    expect(events).toContainEqual([
      'conflict_detected',
      'land sync conflicts: docs/adr/README.md, source.txt',
      { paths: ['docs/adr/README.md', 'source.txt'] },
    ]);
    expect(events.some((event) => Array.isArray(event) && event[0] === 'conflict_resolved')).toBe(false);
  });

  for (const attributes of [false, true]) {
    it(
      attributes
        ? "orders main's entry first even when .gitattributes sets CHANGELOG.md merge=union"
        : "resolves a CHANGELOG.md Unreleased-only conflict with main's entry before the PR's and pushes",
      async () => {
        const f = fixture();
        seedChangelog(f, attributes);
        commitIn(f.main, { 'CHANGELOG.md': changelog(['base (#2)', 'main line (#3)']) }, 'main');
        commitIn(f.lane, { 'CHANGELOG.md': changelog(['base (#2)', 'pr line (#4)']) }, 'lane/topic');
        const before = git(f.lane, 'rev-parse', 'HEAD');
        const events: unknown[] = [];
        const result = await syncLandBranch({
          worktree: f.lane,
          branch: 'lane/topic',
          run: localRun(f.lane),
          log: (...args) => events.push(args),
        });
        expect(result).toEqual({ ok: true });
        const text = readFileSync(join(f.lane, 'CHANGELOG.md'), 'utf8');
        expect(text).not.toContain('<<<<<<<');
        expect(text.indexOf('main line')).toBeGreaterThan(-1);
        expect(text.indexOf('main line')).toBeLessThan(text.indexOf('pr line'));
        expect(git(f.origin, 'rev-parse', 'lane/topic')).toBe(git(f.lane, 'rev-parse', 'HEAD'));
        expect(git(f.lane, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
        expect(git(f.lane, 'rev-parse', 'HEAD^1')).toBe(before);
        expect(events).toContainEqual([
          'conflict_resolved',
          'resolved CHANGELOG.md Unreleased conflict mechanically',
          { mode: 'mechanical', paths: ['CHANGELOG.md'] },
        ]);
      },
    );
  }

  it('parks naming CHANGELOG.md when the conflict is inside a released section', async () => {
    const f = fixture();
    seedChangelog(f);
    commitIn(f.main, { 'CHANGELOG.md': changelog(['base (#2)'], RELEASED.replace('old', 'main edit')) }, 'main');
    commitIn(f.lane, { 'CHANGELOG.md': changelog(['base (#2)'], RELEASED.replace('old', 'pr edit')) }, 'lane/topic');
    const before = git(f.lane, 'rev-parse', 'HEAD');
    const result = await syncLandBranch({
      worktree: f.lane,
      branch: 'lane/topic',
      run: localRun(f.lane),
      log: () => {},
    });
    expect(result).toEqual({ ok: false, message: 'unresolved merge conflicts: CHANGELOG.md', paths: ['CHANGELOG.md'] });
    expect(git(f.lane, 'rev-parse', 'HEAD')).toBe(before);
    expect(() => git(f.lane, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow();
  });

  it('resolves CHANGELOG.md but parks naming only the source path in a mixed conflict', async () => {
    const f = fixture();
    seedChangelog(f);
    commitIn(
      f.main,
      { 'CHANGELOG.md': changelog(['base (#2)', 'main line (#3)']), 'packages/cli/src/cli/run.ts': 'main\n' },
      'main',
    );
    commitIn(
      f.lane,
      { 'CHANGELOG.md': changelog(['base (#2)', 'pr line (#4)']), 'packages/cli/src/cli/run.ts': 'lane\n' },
      'lane/topic',
    );
    const before = git(f.lane, 'rev-parse', 'HEAD');
    const result = await syncLandBranch({
      worktree: f.lane,
      branch: 'lane/topic',
      run: localRun(f.lane),
      log: () => {},
    });
    expect(result).toEqual({
      ok: false,
      message: 'unresolved merge conflicts: packages/cli/src/cli/run.ts',
      paths: ['packages/cli/src/cli/run.ts'],
    });
    expect(git(f.lane, 'rev-parse', 'HEAD')).toBe(before);
    expect(() => git(f.lane, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow();
  });
});
