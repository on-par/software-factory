import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { getFactoryPaths } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { requireRunInputs } from './first-run.js';

const tmp = createTempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

function checkout(withFactory: boolean): string {
  const repo = realpathSync(tmp.makeSync('run-inputs-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  if (withFactory) mkdirSync(join(repo, '.factory'));
  return repo;
}

function exclude(repo: string): string {
  const file = join(repo, '.git', 'info', 'exclude');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

async function outcome(run: Promise<void>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (err) {
    return `${(err as { code?: number }).code ?? '-'} ${(err as Error).message}`;
  }
}

describe('requireRunInputs (#4341)', () => {
  it.each([
    { name: 'no .factory, no external source', withFactory: false, external: false, ok: false },
    { name: 'initialized, no external source', withFactory: true, external: false, ok: true },
    { name: 'no .factory, external source', withFactory: false, external: true, ok: true },
  ])('$name', async ({ withFactory, external, ok }) => {
    const repo = checkout(withFactory);
    const before = exclude(repo);
    const env = external ? { FACTORY_PROJECT_CONFIG_DIR: tmp.makeSync('run-inputs-project-') } : {};
    const paths = getFactoryPaths(repo, undefined, {});

    const got = await outcome(requireRunInputs(repo, paths, env));

    expect(got).toBe(ok ? 'ok' : '2 factory: factory not initialized — run `factory init` first');
    expect([existsSync(paths.logs), existsSync(paths.plans)]).toEqual([external, external]);
    expect(exclude(repo)).toBe(external ? `${before}/.factory/state/\n` : before);
  });

  it('fails naming the source when the external directory is missing', async () => {
    const repo = checkout(false);
    const missing = join(repo, 'missing');

    const got = await outcome(
      requireRunInputs(repo, getFactoryPaths(repo, undefined, {}), { FACTORY_PROJECT_CONFIG_DIR: missing }),
    );

    expect(got).toBe(`- FACTORY_PROJECT_CONFIG_DIR: no such directory: ${missing}`);
    expect(existsSync(join(repo, '.factory'))).toBe(false);
  });
});
