// run-brief with an untracked .factory/config.yaml (#3600): the worktree has no .factory/, yet the real
// CHECK phase runs the checks.build and checks.test the source checkout declares.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkPhase } from '@on-par/factory-core';
import { afterEach, describe, expect, it } from 'vitest';

import { h, installShipHarness, phases, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
const worktrees: string[] = [];

afterEach(() => {
  for (const dir of worktrees.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A source checkout whose committed scripts record their cwd, and whose .factory/ is only excluded locally. */
function sourceWithUntrackedConfig(): void {
  git(h.repoRoot, 'init', '-q', '-b', 'main');
  git(h.repoRoot, 'config', 'user.email', 'test@example.com');
  git(h.repoRoot, 'config', 'user.name', 'Test');
  git(h.repoRoot, 'config', 'commit.gpgsign', 'false');
  for (const step of ['build', 'test']) {
    writeFileSync(
      join(h.repoRoot, `${step}.mjs`),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync('${step}-ran.txt', process.cwd());\n`,
    );
  }
  git(h.repoRoot, 'add', 'build.mjs', 'test.mjs');
  git(h.repoRoot, 'commit', '-q', '-m', 'scripts');
  writeFileSync(join(h.repoRoot, '.git', 'info', 'exclude'), '.factory/\n');
  mkdirSync(join(h.repoRoot, '.factory'), { recursive: true });
  writeFileSync(
    join(h.repoRoot, '.factory', 'config.yaml'),
    'version: 2\nchecks:\n  build: node build.mjs\n  test: node test.mjs\n',
  );
}

describe('run-brief with an untracked .factory/config.yaml (#3600)', () => {
  it('runs the declared checks.build and checks.test in the worktree', async () => {
    sourceWithUntrackedConfig();
    expect(git(h.repoRoot, 'check-ignore', '.factory/config.yaml').trim()).toBe('.factory/config.yaml');
    let worktree = '';
    h.setupWorktreeImpl = async (repoRoot, branch, path) => {
      worktree = path;
      worktrees.push(path);
      git(repoRoot, 'worktree', 'add', '-q', '-b', branch, path, 'HEAD');
    };
    h.constitutionResolve = () => ({
      product: 'default-code',
      version: 1,
      checkers: ['compile', 'tests'],
      body: 'standards',
      path: '/bundled/default-code.md',
      source: 'bundled',
    });
    let check: Awaited<ReturnType<typeof checkPhase>> | undefined;
    const brief = join(h.repoRoot, 'brief.md');
    writeFileSync(brief, '# Add a widget\n\nPlease add a widget.\n\n## Acceptance criteria\n\n- the widget exists\n');

    const res = await runMainWith(
      {
        checkPhase: async (opts) => {
          check = await checkPhase(opts);
          return check;
        },
      },
      'run-brief',
      brief,
    );

    expect(res.exited).toBe(false);
    expect(existsSync(join(worktree, '.factory'))).toBe(false);
    const results = Object.fromEntries(check!.summary.results.map((r) => [r.checker, r]));
    expect(results.compile).toMatchObject({ result: 'PASS', details: 'node build.mjs: OK' });
    expect(results.tests).toMatchObject({ result: 'PASS', details: 'checks.test: OK' });
    for (const step of ['build', 'test']) {
      expect(realpathSync(readFileSync(join(worktree, `${step}-ran.txt`), 'utf-8'))).toBe(realpathSync(worktree));
    }
    expect(phases.shipPhase).toHaveBeenCalled();
    expect(process.env.FACTORY_RUN_CONFIG_JSON).toBeUndefined();
    expect(process.env.FACTORY_RUN_CONFIG_ORIGIN).toBeUndefined();
  });
});
