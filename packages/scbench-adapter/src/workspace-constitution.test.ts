import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConstitutionLoader, runAllCheckers, type ModelRouter } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findLeakedValues } from './leak-guard.js';
import { WORKSPACE_CONSTITUTION } from './workspace-constitution.js';
import { prepareWorkspace, type ExecFn } from './workspace.js';

describe('WORKSPACE_CONSTITUTION', () => {
  it('carries frontmatter the core constitution loader can parse, plus a non-empty body', () => {
    expect(WORKSPACE_CONSTITUTION.startsWith('---\n')).toBe(true);
    const closing = WORKSPACE_CONSTITUTION.indexOf('\n---\n', 4);
    expect(closing).toBeGreaterThan(0);
    const body = WORKSPACE_CONSTITUTION.slice(closing + '\n---\n'.length);
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it('declares requireTests: true in frontmatter', () => {
    const closing = WORKSPACE_CONSTITUTION.indexOf('\n---\n', 4);
    const frontmatter = WORKSPACE_CONSTITUTION.slice(0, closing);
    expect(frontmatter.split('\n')).toContain('requireTests: true');
  });

  it('states the runnable-test expectation in its Verification section', () => {
    const verification = WORKSPACE_CONSTITUTION.slice(WORKSPACE_CONSTITUTION.indexOf('## Verification'));
    expect(verification).toMatch(/runnable/i);
    expect(verification).toContain('requireTests');
  });

  it('mandates clean SIGINT/SIGTERM shutdown of long-running modes', () => {
    expect(WORKSPACE_CONSTITUTION).toContain('SIGINT');
    expect(WORKSPACE_CONSTITUTION).toContain('SIGTERM');
    expect(WORKSPACE_CONSTITUTION).toMatch(/long-running/i);
    expect(WORKSPACE_CONSTITUTION).toMatch(/watch/i);
  });

  it('leaks no hidden-test name or per-problem hint', () => {
    expect(WORKSPACE_CONSTITUTION).not.toContain('test_sigint_shutdown');
    expect(WORKSPACE_CONSTITUTION).not.toContain('cfgpipe');
  });

  it('leaks no retained evaluation.json test name or problem id', () => {
    const hidden = {
      testNames: ['test_hidden_evaluation_case'],
      problemIds: ['calculator', 'hidden-eval-problem-id'],
    };
    expect(findLeakedValues(WORKSPACE_CONSTITUTION, hidden)).toEqual([]);
  });

  it('names the ADR-decided factory-authored test location', () => {
    expect(WORKSPACE_CONSTITUTION).toContain('.factory/tests/');
    expect(WORKSPACE_CONSTITUTION).toContain('ADR-0081');
  });
});

describe('tests checker under the SCBench constitution', () => {
  const tempDirs = createTempDirs();
  let dir: string;
  const exec: ExecFn = async () => ({ exitCode: 0, stdout: '', stderr: '' });
  // The tests checker never touches the router.
  const router = {} as ModelRouter;

  beforeEach(async () => {
    dir = await tempDirs.make('scbench-constitution-');
    await prepareWorkspace(dir, { exec });
    writeFileSync(join(dir, 'app.py'), 'print("hi")\n');
  });

  afterEach(async () => {
    await tempDirs.cleanup();
  });

  it('a test-less workspace fails the tests checker under the SCBench constitution', async () => {
    const constitution = new ConstitutionLoader().loadRepoConstitution(dir);
    expect(constitution?.requireTests).toBe(true);

    const summary = await runAllCheckers(
      { worktree: dir, specPath: join(dir, 'spec.md') },
      router,
      constitution,
      undefined,
      ['tests'],
    );

    const tests = summary.results.find((r) => r.checker === 'tests');
    expect(tests?.result).toBe('FAIL');
    expect(tests?.details).toContain('requireTests');
    expect(summary.failures).toBeGreaterThanOrEqual(1);
  });

  it('a passing pytest surface passes the tests checker under the SCBench constitution', async () => {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'test_app.py'), 'def test_app():\n    assert True\n');
    const constitution = new ConstitutionLoader().loadRepoConstitution(dir);
    const argvs: (readonly string[])[] = [];

    const summary = await runAllCheckers(
      {
        worktree: dir,
        specPath: join(dir, 'spec.md'),
        runCommand: async (argv) => {
          argvs.push(argv);
          return { command: argv, stdout: '', stderr: '', exitCode: 0, killed: false, timedOut: false, ok: true };
        },
      },
      router,
      constitution,
      undefined,
      ['tests'],
    );

    const tests = summary.results.find((r) => r.checker === 'tests');
    expect(tests?.result).toBe('PASS');
    expect(argvs.some((argv) => argv.includes('pytest'))).toBe(true);
  });
});
