import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CheckerOutput } from '../types/index.js';
import { describeCheckOutcome } from './check-outcome.js';
import { type CheckerContext, compileChecker, lintChecker, summarizeCheckerOutputs, testsChecker } from './index.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((d) => rm(d, { recursive: true, force: true })));
  tempDirs.clear();
});

async function makeRepo(files: Record<string, string>): Promise<CheckerContext> {
  const worktree = await mkdtemp(join(tmpdir(), 'no-build-system-'));
  tempDirs.add(worktree);
  await mkdir(worktree, { recursive: true });
  for (const [name, contents] of Object.entries(files)) await writeFile(join(worktree, name), contents);
  return { worktree, specPath: join(worktree, 'no-such-spec.md'), constitutionBody: 'test constitution' };
}

function out(checker: string, result: CheckerOutput['result']): CheckerOutput {
  return { checker, result, details: 'x' };
}

describe('no build system (#3566)', () => {
  it('a repo with no build files skips compile and lint and never says all checkers passed', async () => {
    const ctx = await makeRepo({ 'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>' });

    const compile = await compileChecker(ctx);
    const lint = await lintChecker(ctx);
    const tests = await testsChecker(ctx);

    expect(compile.result).toBe('SKIP');
    expect(compile.details).toContain('no build system detected');
    expect(lint.result).toBe('SKIP');
    expect(lint.details).toContain('no linting configured');
    expect(tests.result).toBe('SKIP');

    const line = describeCheckOutcome(summarizeCheckerOutputs([compile, lint, tests, out('links', 'PASS')]));
    expect(line).not.toContain('All checkers passed');
    expect(line).toContain('1 of 4 checkers ran');
    expect(line).toContain('3 skipped');
  });

  it('a Node repo with build, test and lint scripts keeps PASS results and the All checkers passed summary', async () => {
    const ctx = await makeRepo({
      'package.json': JSON.stringify({ scripts: { build: 'exit 0', test: 'exit 0', lint: 'exit 0' } }),
    });

    const results = [await compileChecker(ctx), await lintChecker(ctx), await testsChecker(ctx)];

    expect(results.map((r) => r.result)).toEqual(['PASS', 'PASS', 'PASS']);
    expect(describeCheckOutcome(summarizeCheckerOutputs(results))).toBe('All checkers passed');
  });

  it('describeCheckOutcome keeps the old text when only one of compile and tests skipped', () => {
    expect(describeCheckOutcome(summarizeCheckerOutputs([out('compile', 'SKIP'), out('tests', 'PASS')]))).toBe(
      'All checkers passed (1 skipped)',
    );
    expect(describeCheckOutcome(summarizeCheckerOutputs([out('compile', 'PASS'), out('tests', 'SKIP')]))).toBe(
      'All checkers passed (1 skipped)',
    );
    expect(describeCheckOutcome(summarizeCheckerOutputs([out('links', 'PASS')]))).toBe('All checkers passed');
  });
});
