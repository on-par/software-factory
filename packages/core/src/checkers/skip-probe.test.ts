// SKIP details name the config file and directory the resolvers probed for `checks` (#3600).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { holdRunConfigSnapshot } from '../config/run-config-source.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { type CheckerContext, compileChecker, lintChecker, testsChecker } from './index.js';
import { describeChecksProbe, resolveTestsCommand } from './resolve-commands.js';

const tmp = createTempDirs();
let release: (() => void) | undefined;

afterEach(async () => {
  release?.();
  release = undefined;
  vi.unstubAllEnvs();
  await tmp.cleanup();
});

function checkout(prefix: string, factoryFiles: Record<string, string> = {}): string {
  const dir = tmp.makeSync(prefix);
  if (Object.keys(factoryFiles).length > 0) mkdirSync(join(dir, '.factory'));
  for (const [name, text] of Object.entries(factoryFiles)) writeFileSync(join(dir, '.factory', name), text);
  return dir;
}

const ctxFor = (worktree: string): CheckerContext => ({ worktree, specPath: join(worktree, 'spec.md') });

async function skipDetails(ctx: CheckerContext): Promise<string[]> {
  const results = [await compileChecker(ctx), await testsChecker(ctx), await lintChecker(ctx)];
  expect(results.map((r) => r.result)).toEqual(['SKIP', 'SKIP', 'SKIP']);
  return results.map((r) => r.details);
}

describe('skip details name the probed config file (#3600)', () => {
  it('a worktree with no .factory/ names the worktree file and the other probed names', async () => {
    const worktree = checkout('skip-probe-wt-');
    const probed = `${worktree}/.factory/config.yaml (worktree; also probed config.yml, config.json)`;

    const [compile, tests, lint] = await skipDetails(ctxFor(worktree));

    expect(compile).toBe(
      `no build system detected (no checks.build in ${probed}, no package.json build script, Makefile or Cargo.toml) — skipped`,
    );
    expect(tests).toContain(`no checks.test in ${probed}, no scripts/verify.sh`);
    expect(lint).toContain(`no checks.lint in ${probed}, no package.json lint script`);
  });

  it('a worktree config.json without checks is named alone', async () => {
    const worktree = checkout('skip-probe-wt-', { 'config.json': JSON.stringify({ version: 2 }) });

    const [compile] = await skipDetails(ctxFor(worktree));

    expect(compile).toContain(`no checks.build in ${worktree}/.factory/config.json (worktree),`);
  });

  it('the requireTests FAIL names the probed file too', async () => {
    const worktree = checkout('skip-probe-wt-');

    const tests = await testsChecker({ ...ctxFor(worktree), testsRequired: true });

    expect(tests.result).toBe('FAIL');
    expect(tests.details).toContain(`no checks.test in ${worktree}/.factory/config.yaml (worktree; also probed`);
  });

  it('a one-shot run names the source checkout file it snapshotted', async () => {
    const source = checkout('skip-probe-src-', { 'config.yaml': 'version: 2\n' });
    release = holdRunConfigSnapshot(join(source, '.factory', 'config.yaml'));

    const [compile, tests] = await skipDetails(ctxFor(checkout('skip-probe-wt-')));

    expect(compile).toContain(`no checks.build in the run config snapshot of ${source}/.factory/config.yaml,`);
    expect(tests).toContain(`no checks.test in the run config snapshot of ${source}/.factory/config.yaml,`);
  });

  it('a daemon snapshot without an origin is named as such', () => {
    vi.stubEnv('FACTORY_RUN_CONFIG_JSON', JSON.stringify({ version: 2 }));

    expect(describeChecksProbe({ worktree: '/wt' })).toBe('the daemon run config snapshot (FACTORY_RUN_CONFIG_JSON)');
  });

  it('labels the checkout for doctor and the explicit checks seam', () => {
    expect(describeChecksProbe({ worktree: '/repo' }, 'source checkout')).toBe(
      '/repo/.factory/config.yaml (source checkout; also probed config.yml, config.json)',
    );
    expect(describeChecksProbe({ worktree: '/repo', checks: null })).toBe('the checks passed to CHECK');
  });

  it('a command declared in the snapshot is labelled with the source file name, not the worktree', async () => {
    const source = checkout('skip-probe-src-', { 'config.json': JSON.stringify({ checks: { test: 'make test' } }) });
    release = holdRunConfigSnapshot(join(source, '.factory', 'config.json'));

    const cmd = await resolveTestsCommand({ worktree: checkout('skip-probe-wt-') });

    expect(cmd).toMatchObject({ runner: 'config', argv: ['make', 'test'], source: '.factory/config.json' });
  });

  it('a daemon snapshot command gets a snapshot label', async () => {
    vi.stubEnv('FACTORY_RUN_CONFIG_JSON', JSON.stringify({ version: 2, checks: { test: 'make test' } }));

    const cmd = await resolveTestsCommand({ worktree: checkout('skip-probe-wt-') });

    expect(cmd.source).toBe('.factory/config (run config snapshot)');
  });
});
