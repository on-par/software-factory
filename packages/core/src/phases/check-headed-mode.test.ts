import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { checkPhase } from './check.js';

const dirs = createTempDirs();
const green = { failures: 0, passes: 0, skips: 0, total: 0, results: [] };

afterEach(async () => {
  await dirs.cleanup();
});

async function fixture(files: Record<string, string>): Promise<string> {
  const worktree = await dirs.make('check-headed-');
  await writeFile(
    join(worktree, 'package.json'),
    JSON.stringify({ scripts: { test: 'true', ...JSON.parse(files['package.json'] ?? '{}').scripts } }),
  );
  for (const [name, content] of Object.entries(files)) {
    if (name !== 'package.json') await writeFile(join(worktree, name), content);
  }
  return worktree;
}

async function check(
  worktree: string,
  router: unknown = {},
): Promise<{ warnings?: string[]; passed: boolean; logs: string[] }> {
  const logs: string[] = [];
  const result = await checkPhase({
    issue: 3266,
    worktree,
    specPath: join(worktree, 'missing-spec.md'),
    router: router as never,
    constitution: null,
    log: (type, message) => logs.push(`${type}: ${message}`),
    autoRework: false,
    runCheckers: async () => green,
  });
  return { warnings: result.summary.warnings, passed: result.passed, logs };
}

describe('checkPhase headed-mode warnings', () => {
  it('warns and records a Playwright config that forces headless false', async () => {
    const worktree = await fixture({ 'playwright.config.ts': 'export default { use: { headless: false } };' });
    const result = await check(worktree);
    expect(result.logs.some((line) => line.includes('environment_warning') && line.includes('headless: false'))).toBe(
      true,
    );
    expect(result.warnings).toEqual(['playwright.config.ts forces headless: false']);
  });

  it('warns for headed Playwright and interactive Cypress scripts', async () => {
    const worktree = await fixture({
      'package.json': JSON.stringify({ scripts: { e2e: 'playwright test --headed', cy: 'cypress open' } }),
    });
    const result = await check(worktree);
    expect(result.logs.some((line) => line.includes('environment_warning') && line.includes('--headed'))).toBe(true);
    expect(result.logs.some((line) => line.includes('environment_warning') && line.includes('cypress open'))).toBe(
      true,
    );
    expect(result.warnings).toEqual([
      "package.json script 'e2e' passes --headed",
      "package.json script 'cy' runs 'cypress open' (interactive UI runner)",
    ]);
  });

  it('does not warn for headless defaults', async () => {
    const worktree = await fixture({
      'playwright.config.ts': 'export default {};',
      'package.json': JSON.stringify({ scripts: { e2e: 'playwright test' } }),
    });
    const result = await check(worktree);
    expect(result.logs.some((line) => line.includes('headed e2e config detected'))).toBe(false);
    expect(result.warnings).toBeUndefined();
  });

  it('drops the warning after rework fixes the headed config', async () => {
    const worktree = await fixture({ 'playwright.config.ts': 'export default { use: { headless: false } };' });
    let checkerRuns = 0;
    const router = {
      run: async () => {
        await writeFile(join(worktree, 'playwright.config.ts'), 'export default { use: { headless: true } };');
        return { model: 'fake', output: 'fixed', exitCode: 0, attempts: [] };
      },
    };
    const result = await checkPhase({
      issue: 3266,
      worktree,
      specPath: join(worktree, 'missing-spec.md'),
      router: router as never,
      constitution: null,
      log: () => {},
      runCheckers: async () => {
        checkerRuns++;
        return checkerRuns === 1
          ? {
              failures: 1,
              passes: 0,
              skips: 0,
              total: 1,
              results: [{ checker: 'tests', result: 'FAIL', details: 'fix config' }],
            }
          : green;
      },
    });
    expect(result.passed).toBe(true);
    expect(result.reworkRounds).toBe(1);
    expect(result.summary.warnings).toBeUndefined();
  });
});
