import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { execGit } from '../utils/git-exec.js';
import {
  describeSuppression,
  mergeBaseIntoWorktree,
  readReworkDiff,
  readWorktreeHead,
  scanReworkDiff,
} from './ci-suppression-guard.js';

const added = (file: string, line: string): string =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,0 +7,1 @@\n+${line}\n`;

describe('scanReworkDiff flags suppression comments', () => {
  it.each([
    ['// codeql[js/request-forgery]', 'codeql-comment'],
    ['// lgtm[js/xss]', 'lgtm-comment'],
    ['x = 1 // lgtm', 'lgtm-comment'],
    ['# nosec B602', 'nosec-comment'],
    ['// #nosec G101', 'nosec-comment'],
    ['// eslint-disable-next-line security/detect-object-injection', 'eslint-disable-security'],
    ['/* eslint-disable */', 'eslint-disable-security'],
    ['// eslint-disable-line security/detect-non-literal-fs-filename -- ok', 'eslint-disable-security'],
  ])('%s -> %s', (line, rule) => {
    expect(scanReworkDiff(added('src/a.ts', line))).toEqual([
      expect.objectContaining({ kind: 'comment', rule, file: 'src/a.ts', line: 7 }),
    ]);
  });

  it('applies comment rules to a diff with no file header', () => {
    expect(scanReworkDiff('+// codeql[js/xss]\n')).toEqual([
      expect.objectContaining({ rule: 'codeql-comment', file: '(unknown)' }),
    ]);
  });
});

describe('scanReworkDiff flags protected paths', () => {
  it.each([
    [
      'modified workflow',
      'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1 +1 @@\n+x\n',
      'workflow-path',
    ],
    [
      'deleted workflow',
      'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n',
      'workflow-path',
    ],
    [
      'renamed workflow',
      'diff --git a/.github/workflows/x.yml b/tmp/x.yml\nsimilarity index 100%\nrename from .github/workflows/x.yml\nrename to tmp/x.yml\n',
      'workflow-path',
    ],
    [
      'codeql dir config',
      'diff --git a/.github/codeql/codeql-config.yml b/.github/codeql/codeql-config.yml\n--- a/.github/codeql/codeql-config.yml\n+++ b/.github/codeql/codeql-config.yml\n@@ -1 +1 @@\n+x\n',
      'codeql-path',
    ],
    [
      'root codeql config',
      'diff --git a/codeql-config.yml b/codeql-config.yml\n--- a/codeql-config.yml\n+++ b/codeql-config.yml\n@@ -1 +1 @@\n+x\n',
      'codeql-path',
    ],
    [
      'binary sarif',
      'diff --git a/results/out.sarif b/results/out.sarif\nBinary files a/results/out.sarif and b/results/out.sarif differ\n',
      'sarif-path',
    ],
  ])('%s -> %s', (_name, diff, rule) => {
    expect(scanReworkDiff(diff).map((f) => f.rule)).toContain(rule);
    expect(scanReworkDiff(diff).every((f) => f.kind === 'path')).toBe(true);
  });
});

describe('scanReworkDiff passes clean diffs', () => {
  it.each([
    ['empty', ''],
    ['real fix', added('src/a.ts', 'const url = validate(input);')],
    ['removed suppression', 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -3 +3,0 @@\n-// codeql[js/xss]\n'],
    ['non-security eslint-disable', added('src/a.ts', '// eslint-disable-next-line no-console')],
    ['codeql-named source', added('src/codeql-alerts.ts', 'export const a = 1;')],
    ['file header line', '+++ b/foo.ts\n'],
  ])('%s', (_name, diff) => {
    expect(scanReworkDiff(diff)).toEqual([]);
  });
});

describe('describeSuppression', () => {
  it('lists comment and path findings', () => {
    const text = describeSuppression([
      { kind: 'comment', rule: 'codeql-comment', file: 'src/a.ts', line: 12, match: 'x' },
      { kind: 'path', rule: 'workflow-path', file: '.github/workflows/c.yml', match: '.github/workflows/c.yml' },
    ]);
    expect(text).toBe(
      'suppression-attempt: 2 finding(s): codeql-comment at src/a.ts:12, workflow-path .github/workflows/c.yml',
    );
  });

  it('caps the listed items at 5', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      kind: 'path' as const,
      rule: 'sarif-path',
      file: `${i}.sarif`,
      match: `${i}.sarif`,
    }));
    const text = describeSuppression(many);
    expect(text).toContain('7 finding(s)');
    expect(text).toContain(', +2 more');
    expect(text).not.toContain('5.sarif');
  });
});

const edit = (file: string, removed: string[], added: string[]): string =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -3,${removed.length} +3,${added.length} @@\n` +
  removed.map((l) => `-${l}\n`).join('') +
  added.map((l) => `+${l}\n`).join('');

describe('scanReworkDiff flags ratchet tampering (#3537)', () => {
  const baseline = 'max-lines-baseline.json';
  it('flags a raised max-lines ceiling', () => {
    expect(scanReworkDiff(edit(baseline, ['  "a.ts": 789,'], ['  "a.ts": 790,']))).toEqual([
      { kind: 'ratchet', rule: 'max-lines-ceiling', file: baseline, match: '"a.ts" 789 -> 790' },
    ]);
  });
  it('flags a newly added max-lines entry', () => {
    expect(scanReworkDiff(edit(baseline, [], ['  "b.ts": 600']))).toEqual([
      expect.objectContaining({ rule: 'max-lines-ceiling', match: '"b.ts" new -> 600' }),
    ]);
  });
  it('flags a raise that spans separate hunks', () => {
    const diff = edit(baseline, ['  "a.ts": 5,'], []) + '@@ -9,0 +9,1 @@\n+  "a.ts": 6,\n';
    expect(scanReworkDiff(diff)).toHaveLength(1);
  });
  it('allows a lowered or removed max-lines entry', () => {
    expect(scanReworkDiff(edit(baseline, ['  "a.ts": 789,'], ['  "a.ts": 700,']))).toEqual([]);
    expect(scanReworkDiff(edit(baseline, ['  "a.ts": 789,'], []))).toEqual([]);
  });
  it('flags a lowered or removed vitest threshold', () => {
    expect(scanReworkDiff(edit('vitest.config.ts', ['      lines: 80,'], ['      lines: 78,']))).toEqual([
      expect.objectContaining({ kind: 'ratchet', rule: 'coverage-threshold', match: 'lines 80 -> 78', line: 3 }),
    ]);
    expect(scanReworkDiff(edit('packages/x/vitest.config.mts', ['      branches: 70,'], []))).toEqual([
      expect.objectContaining({ rule: 'coverage-threshold', match: 'branches 70 -> removed' }),
    ]);
  });
  it('allows a raised vitest threshold', () => {
    expect(scanReworkDiff(edit('vitest.config.ts', ['      lines: 80,'], ['      lines: 82,']))).toEqual([]);
  });
  it('ignores max-lines- and threshold-shaped lines in other files', () => {
    expect(scanReworkDiff(edit('src/a.json', ['  "a.ts": 1,'], ['  "a.ts": 2,']))).toEqual([]);
    expect(scanReworkDiff(edit('src/a.ts', ['lines: 80'], ['lines: 10']))).toEqual([]);
  });
  it('describeSuppression renders a ratchet finding', () => {
    const findings = scanReworkDiff(edit(baseline, ['  "a.ts": 1,'], ['  "a.ts": 2,']));
    expect(describeSuppression(findings)).toBe('suppression-attempt: 1 finding(s): max-lines-ceiling "a.ts" 1 -> 2');
  });
});

describe('git readers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-suppression-guard-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execGit(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });

  it('reads HEAD and the committed diff since a prior sha', async () => {
    await git('init', '-q');
    writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'one');
    const before = await readWorktreeHead(dir);
    expect(before).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n// codeql[js/xss]\n');
    await git('commit', '-q', '-am', 'two');
    const diff = await readReworkDiff(dir, before);
    expect(scanReworkDiff(diff)).toEqual([expect.objectContaining({ rule: 'codeql-comment', file: 'a.ts', line: 2 })]);
  });

  it('readWorktreeHead rejects outside a git repository', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ci-suppression-guard-empty-'));
    try {
      await expect(readWorktreeHead(empty)).rejects.toThrow();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  describe('mergeBaseIntoWorktree', () => {
    const tmp = createTempDirs();
    const root = tmp.makeSync('ci-merge-base-');
    afterAll(() => tmp.cleanup());
    const gitIn = (cwd: string, ...args: string[]) =>
      execGit(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });

    async function setup(name: string) {
      const origin = join(root, `${name}-origin.git`);
      const clone = join(root, `${name}-clone`);
      const other = join(root, `${name}-other`);
      await execGit(['init', '-q', '--bare', '-b', 'main', origin], { cwd: root });
      await execGit(['clone', '-q', origin, clone], { cwd: root });
      await execGit(['clone', '-q', origin, other], { cwd: root });
      writeFileSync(join(clone, 'a.txt'), 'one\n');
      await gitIn(clone, 'add', '.');
      await gitIn(clone, 'commit', '-q', '-m', 'init');
      await gitIn(clone, 'push', '-q', 'origin', 'main');
      await gitIn(other, 'pull', '-q', 'origin', 'main');
      await gitIn(clone, 'checkout', '-q', '-b', 'lane');
      return { clone, other };
    }

    it('merges new base commits, then reports up to date', async () => {
      const { clone, other } = await setup('clean');
      writeFileSync(join(other, 'b.txt'), 'base\n');
      await gitIn(other, 'add', '.');
      await gitIn(other, 'commit', '-q', '-m', 'base change');
      await gitIn(other, 'push', '-q', 'origin', 'main');
      await gitIn(clone, 'config', 'user.name', 't');
      await gitIn(clone, 'config', 'user.email', 't@t');
      expect(await mergeBaseIntoWorktree(clone, 'main')).toEqual({ ok: true, merged: true });
      expect(await mergeBaseIntoWorktree(clone, 'main')).toEqual({ ok: true, merged: false });
    });

    it('aborts a conflicting merge and returns the paths', async () => {
      const { clone, other } = await setup('conflict');
      await gitIn(clone, 'config', 'user.name', 't');
      await gitIn(clone, 'config', 'user.email', 't@t');
      writeFileSync(join(clone, 'a.txt'), 'lane\n');
      await gitIn(clone, 'commit', '-q', '-am', 'lane change');
      writeFileSync(join(other, 'a.txt'), 'base\n');
      await gitIn(other, 'commit', '-q', '-am', 'base change');
      await gitIn(other, 'push', '-q', 'origin', 'main');
      expect(await mergeBaseIntoWorktree(clone, 'main')).toEqual({ ok: false, conflict: true, paths: ['a.txt'] });
      await expect(gitIn(clone, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).rejects.toThrow();
    });

    it('reports a failed fetch of a missing ref as a non-conflict error', async () => {
      const { clone } = await setup('missing');
      expect(await mergeBaseIntoWorktree(clone, 'no-such-branch')).toMatchObject({ ok: false, conflict: false });
    });
  });
});
