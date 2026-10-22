import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { execGit } from '../utils/git-exec.js';
import { describeSuppression, readReworkDiff, readWorktreeHead, scanReworkDiff } from './ci-suppression-guard.js';

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
});

describe('scanReworkDiff flags threshold changes (#3537)', () => {
  const diff = (file: string, removed: string[], addedLines: string[]): string =>
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n` +
    [...removed.map((l) => `-${l}`), ...addedLines.map((l) => `+${l}`)].join('\n') +
    '\n';
  const rules = (d: string): string[] => scanReworkDiff(d).map((f) => `${f.rule} ${f.match}`);

  it('flags a raised max-lines-baseline.json ceiling and a lowered vitest.config.ts threshold', () => {
    expect(rules(diff('max-lines-baseline.json', ['  "a.ts": 10,'], ['  "a.ts": 20,']))).toEqual([
      'max-lines-ceiling-raised a.ts 10 -> 20',
    ]);
    expect(rules(diff('vitest.config.ts', ['  lines: 80,'], ['  lines: 70,']))).toEqual([
      'coverage-threshold-lowered |lines 80 -> 70',
    ]);
  });

  it('flags a new baseline key but not a lowered or deleted one', () => {
    expect(rules(diff('max-lines-baseline.json', [], ['  "b.ts": 5']))).toEqual([
      'max-lines-ceiling-raised b.ts (new) -> 5',
    ]);
    expect(rules(diff('max-lines-baseline.json', ['  "a.ts": 10,'], ['  "a.ts": 9,']))).toEqual([]);
    expect(rules(diff('max-lines-baseline.json', ['  "a.ts": 10,'], []))).toEqual([]);
  });

  it('does not flag a raised vitest threshold or a non-threshold edit, but flags a removed metric', () => {
    expect(rules(diff('vitest.config.ts', ['  lines: 80,'], ['  lines: 85,']))).toEqual([]);
    expect(rules(diff('vitest.config.ts', ['  reporter: "x",'], ['  reporter: "y",']))).toEqual([]);
    expect(rules(diff('vitest.config.ts', ['  branches: 70,'], []))).toEqual([
      'coverage-threshold-lowered |branches 70 -> (removed)',
    ]);
  });

  it('compares per-glob rows per glob', () => {
    const found = rules(
      diff(
        'vitest.config.ts',
        ["  'a/**': { lines: 90 },", "  'b/**': { lines: 90 },"],
        ["  'a/**': { lines: 90 },", "  'b/**': { lines: 80 },"],
      ),
    );
    expect(found).toEqual(['coverage-threshold-lowered b/**|lines 90 -> 80']);
  });

  it('describeSuppression renders a threshold finding', () => {
    const f = scanReworkDiff(diff('vitest.config.ts', ['  lines: 80,'], ['  lines: 70,']));
    expect(describeSuppression(f)).toContain('coverage-threshold-lowered |lines 80 -> 70');
  });
});
