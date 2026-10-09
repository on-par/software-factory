import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRunDiffstatJson, NoRunError, parseDiffstatIssue, parseNumstat } from './runs-diffstat.js';

let dir: string;
let repo: string;
let runsDir: string;

const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
const resolveBase = async (): Promise<string> => 'origin/main';
const writeState = (n: number, branch: unknown): void => {
  writeFileSync(
    join(runsDir, `issue-${n}.json`),
    JSON.stringify({ issue: n, lane: 'daw', branch, updatedAt: '2026-01-01T00:00:00Z' }),
  );
};
const build = (issue: number, base = resolveBase) =>
  buildRunDiffstatJson({ runsDir, repoRoot: repo, issue, resolveBase: base });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'factory-diffstat-'));
  repo = join(dir, 'repo');
  runsDir = join(dir, 'runs');
  mkdirSync(repo);
  mkdirSync(runsDir);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2]));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', 'factory/7');
  writeState(7, 'factory/7');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildRunDiffstatJson', () => {
  it('reports per-file counts and totals', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\nx\ny\n');
    writeFileSync(join(repo, 'c.txt'), '1\n2\n3\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'work');

    const out = await build(7);

    expect([...(out.files ?? [])].sort((l, r) => l.path.localeCompare(r.path))).toEqual([
      { path: 'a.txt', added: 2, deleted: 1 },
      { path: 'c.txt', added: 3, deleted: 0 },
    ]);
    expect(out.totals).toEqual({ files: 2, added: 5, deleted: 1 });
    expect(out).toMatchObject({ schemaVersion: 1, issue: 7, reason: null, base: 'origin/main', branch: 'factory/7' });
  });

  it('reports a binary file with null counts', async () => {
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 9, 9, 0, 5]));
    writeFileSync(join(repo, 'b.txt'), 'b\nc\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'work');

    const out = await build(7);

    expect(out.files).toContainEqual({ path: 'bin.dat', added: null, deleted: null });
    expect(out.totals).toEqual({ files: 2, added: 1, deleted: 0 });
  });

  it('returns branch-missing when the branch is gone', async () => {
    writeState(7, 'factory/gone');

    const out = await build(7);

    expect(out).toMatchObject({ files: null, totals: null, reason: 'branch-missing' });
  });

  it('resolves a branch that only exists on origin', async () => {
    writeFileSync(join(repo, 'c.txt'), '1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'work');
    git('update-ref', 'refs/remotes/origin/factory/8', 'HEAD');
    git('checkout', '-q', 'main');
    git('branch', '-D', 'factory/7');
    writeState(8, 'factory/8');

    const out = await build(8);

    expect(out.totals).toEqual({ files: 1, added: 1, deleted: 0 });
  });

  it('rejects with NoRunError when there is no state', async () => {
    await expect(build(99)).rejects.toBeInstanceOf(NoRunError);
  });

  it('returns no-branch for an empty branch', async () => {
    writeState(7, '');

    expect(await build(7)).toMatchObject({ branch: null, files: null, reason: 'no-branch' });
  });

  it('returns base-missing when the base ref does not resolve', async () => {
    const out = await build(7, async () => 'origin/nope');

    expect(out).toMatchObject({ files: null, totals: null, reason: 'base-missing' });
  });

  it('returns an empty diff when the branch equals the base', async () => {
    const out = await build(7);

    expect(out.files).toEqual([]);
    expect(out.totals).toEqual({ files: 0, added: 0, deleted: 0 });
  });

  it('propagates a diff failure', async () => {
    await expect(
      buildRunDiffstatJson({
        runsDir,
        repoRoot: repo,
        issue: 7,
        resolveBase,
        git: async (args) => {
          if (args[0] === 'diff') throw new Error('boom');
          return '';
        },
      }),
    ).rejects.toThrow('boom');
  });
});

describe('parseNumstat', () => {
  it('parses text and binary records', () => {
    expect(parseNumstat('2\t1\ta.txt\0-\t-\tbin.dat\0')).toEqual([
      { path: 'a.txt', added: 2, deleted: 1 },
      { path: 'bin.dat', added: null, deleted: null },
    ]);
  });

  it('keeps spaces and tabs in paths', () => {
    expect(parseNumstat('1\t0\tmy file.txt\0' + '1\t0\ta\tb.txt\0')).toEqual([
      { path: 'my file.txt', added: 1, deleted: 0 },
      { path: 'a\tb.txt', added: 1, deleted: 0 },
    ]);
  });

  it('returns [] for empty input and skips malformed tokens', () => {
    expect(parseNumstat('')).toEqual([]);
    expect(parseNumstat('garbage\0')).toEqual([]);
  });
});

describe('parseDiffstatIssue', () => {
  it('accepts a positive integer', () => {
    expect(parseDiffstatIssue('12')).toBe(12);
  });

  it.each(['0', '-1', 'abc', '12abc', ''])('rejects %j', (raw) => {
    expect(() => parseDiffstatIssue(raw)).toThrow('invalid --diffstat');
  });
});
