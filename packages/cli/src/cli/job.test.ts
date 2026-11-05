import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveRunConfigLadder } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { CliExitError } from './errors.js';
import {
  CONTAINER_JOB_DEFAULTS,
  jobChildArgs,
  jobStatusLine,
  resolveJobConfigSources,
  validateJobFlags,
  type JobFlags,
} from './job.js';
import { jobStatusJsonSchema } from './job-status-contract.js';
import type { RunResultJson } from './json-contract.js';

const tempDirs = createTempDirs();
afterEach(async () => {
  await tempDirs.cleanup();
});

const env = { GH_TOKEN: 'ghp_x', CLAUDE_CODE_OAUTH_TOKEN: 'sk-x', HOME: '/home/node' };
const base = { repo: 'on-par/foreman', issue: '12' };

function exitCodeOf(fn: () => unknown): { code: number; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof CliExitError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error('did not throw');
}

describe('validateJobFlags', () => {
  it('accepts a valid repo and issue and defaults the workdir under HOME', () => {
    expect(validateJobFlags(base, env)).toEqual({
      repo: 'on-par/foreman',
      owner: 'on-par',
      name: 'foreman',
      issue: 12,
      mode: 'pr',
      workdir: '/home/node/work',
      factoryDir: undefined,
    });
  });

  it.each(['..', 'a/b/c', 'https://github.com/a/b', 'a', '../x', 'a/..', './b', ''])('rejects repo %j', (repo) => {
    expect(exitCodeOf(() => validateJobFlags({ ...base, repo }, env))).toEqual({
      code: 2,
      message: 'factory job: --repo must be <owner>/<name>',
    });
  });

  it.each(['0', '01', '3x', '-1', '', '1.5'])('rejects issue %j', (issue) => {
    expect(exitCodeOf(() => validateJobFlags({ ...base, issue }, env)).code).toBe(2);
  });

  it('rejects --merge with --no-pr and maps the modes', () => {
    expect(exitCodeOf(() => validateJobFlags({ ...base, merge: true, pr: false }, env)).message).toContain('exclusive');
    expect(validateJobFlags({ ...base, merge: true }, env).mode).toBe('merge');
    expect(validateJobFlags({ ...base, pr: false }, env).mode).toBe('no-pr');
  });

  it('names missing secrets without echoing values', () => {
    expect(exitCodeOf(() => validateJobFlags(base, { ...env, GH_TOKEN: undefined })).message).toContain('GH_TOKEN');
    expect(exitCodeOf(() => validateJobFlags(base, { ...env, GH_TOKEN: '  ' })).message).toContain('GH_TOKEN');
    const none = exitCodeOf(() => validateJobFlags(base, { GH_TOKEN: 'ghp_SECRET', CLAUDE_CODE_OAUTH_TOKEN: ' ' }));
    expect(none.message).toContain('CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY');
    expect(none.message).not.toContain('ghp_SECRET');
    expect(validateJobFlags(base, { GH_TOKEN: 'g', ANTHROPIC_API_KEY: 'k' }).issue).toBe(12);
  });

  it('resolves workdir and factory dir, with the env fallback for the factory dir', () => {
    expect(validateJobFlags({ ...base, workdir: '/w' }, env).workdir).toBe('/w');
    expect(validateJobFlags(base, { ...env, FACTORY_JOB_FACTORY_DIR: '/mnt/f' }).factoryDir).toBe('/mnt/f');
    expect(
      validateJobFlags({ ...base, factoryDir: '/x' }, { ...env, FACTORY_JOB_FACTORY_DIR: '/mnt/f' }).factoryDir,
    ).toBe('/x');
    expect(validateJobFlags(base, { ...env, FACTORY_JOB_FACTORY_DIR: ' ' }).factoryDir).toBeUndefined();
  });
});

describe('resolveJobConfigSources', () => {
  const clone = '/work/foreman';
  const defaults = '/work/.factory-job/container-defaults.yaml';
  const resolve = (present: string[], e: NodeJS.ProcessEnv = {}, factoryDir?: string) =>
    resolveJobConfigSources(
      { cloneDir: clone, factoryDir, containerDefaultsPath: defaults, exists: (p) => present.includes(p) },
      e,
    );

  it("uses the repo's committed .factory/config.yaml when no override is set", () => {
    const s = resolve([`${clone}/.factory/config.yaml`]);
    expect(s).toMatchObject({ configSource: 'repo .factory/config.yaml', writeContainerDefaults: false, env: {} });
  });

  it('names the config and constitution source in the log line', () => {
    const s = resolve([`${clone}/.factory/config.yaml`, `${clone}/.factory/constitution.md`]);
    expect(s.configSource).toBe('repo .factory/config.yaml');
    expect(s.constitutionSource).toBe('repo .factory/constitution.md');
    expect(resolve([]).constitutionSource).toBe('repo instruction files / bundled');
  });

  it("FACTORY_CONFIG_YAML wins over the repo's committed config", () => {
    const s = resolve([`${clone}/.factory/config.yaml`], { FACTORY_CONFIG_YAML: 'version: 2' });
    expect(s.configSource).toBe('FACTORY_CONFIG_YAML');
  });

  it('a mounted .factory dir wins over FACTORY_CONFIG_YAML and the repo config', () => {
    const s = resolve(['/mnt/f/config.yaml', `${clone}/.factory/config.yaml`], { FACTORY_CONFIG_YAML: 'v' }, '/mnt/f');
    expect(s.configSource).toBe('mounted .factory dir (/mnt/f/config.yaml)');
    expect(s.env).toEqual({ FACTORY_CONFIG_PATH: '/mnt/f/config.yaml' });
  });

  it('--config wins over every other source', () => {
    const s = resolve(
      ['/mnt/f/config.yaml'],
      { FACTORY_CONFIG_PATH: '/c.yaml', FACTORY_CONFIG_PATH_SOURCE: '--config', FACTORY_CONFIG_YAML: 'v' },
      '/mnt/f',
    );
    expect(s.configSource).toBe('--config (/c.yaml)');
    expect(s.env).toEqual({});
    expect(resolve([], { FACTORY_CONFIG_PATH: '/c.yaml' }).configSource).toBe('FACTORY_CONFIG_PATH (/c.yaml)');
  });

  it('falls back to container defaults when the repo has no config', () => {
    const s = resolve([]);
    expect(s).toMatchObject({
      configSource: 'container defaults',
      writeContainerDefaults: true,
      env: { FACTORY_CONFIG_PATH: defaults },
    });
  });

  it('notes FACTORY_CONFIG_OVERRIDES on the config label without key paths', () => {
    expect(resolve([], { FACTORY_CONFIG_OVERRIDES: 'disk:\n  minFreeGb: 2\n' }).configSource).toBe(
      'container defaults; overrides: FACTORY_CONFIG_OVERRIDES',
    );
  });

  it('orders the constitution sources', () => {
    const present = ['/mnt/f/constitution.md', `${clone}/.factory/constitution.md`, '/mnt/f/config.yaml'];
    expect(
      resolve(
        present,
        { FACTORY_CONSTITUTION_PATH: '/k.md', FACTORY_CONSTITUTION_PATH_SOURCE: '--constitution' },
        '/mnt/f',
      ).constitutionSource,
    ).toBe('--constitution (/k.md)');
    expect(resolve(present, { FACTORY_CONSTITUTION_PATH: '/k.md' }).constitutionSource).toBe(
      'FACTORY_CONSTITUTION_PATH (/k.md)',
    );
    const mounted = resolve(present, { FACTORY_CONSTITUTION: 'text' }, '/mnt/f');
    expect(mounted.constitutionSource).toBe('mounted .factory dir (/mnt/f/constitution.md)');
    expect(mounted.env.FACTORY_CONSTITUTION_PATH).toBe('/mnt/f/constitution.md');
    expect(resolve([], { FACTORY_CONSTITUTION: 'text' }).constitutionSource).toBe('FACTORY_CONSTITUTION');
  });

  it('rejects a mounted dir with neither a config file nor constitution.md', () => {
    expect(exitCodeOf(() => resolve([], {}, '/mnt/empty'))).toEqual({
      code: 2,
      message: 'factory job: --factory-dir /mnt/empty has no config file or constitution.md',
    });
  });

  it('accepts a mounted dir with only a constitution', () => {
    const s = resolve(['/mnt/f/constitution.md'], {}, '/mnt/f');
    expect(s.configSource).toBe('container defaults');
  });
});

describe('container defaults', () => {
  function writeDefaults(): string {
    const dir = tempDirs.makeSync('factory-job-');
    const path = join(dir, 'container-defaults.yaml');
    writeFileSync(path, `${JSON.stringify(CONTAINER_JOB_DEFAULTS, null, 2)}\n`);
    return path;
  }

  it('container defaults set sandbox.runtime none and a 2 GiB disk floor when the repo has no config', () => {
    expect(CONTAINER_JOB_DEFAULTS).toEqual({ version: 2, sandbox: { runtime: 'none' }, disk: { minFreeGb: 2 } });
    const ladder = resolveRunConfigLadder(writeDefaults(), { FACTORY_CONFIG_PATH: writeDefaults() });
    expect(ladder.raw).toMatchObject({ sandbox: { runtime: 'none' } });
  });

  it('container defaults resolve to a disk guard floor of 2 GiB', () => {
    const path = writeDefaults();
    const ladder = resolveRunConfigLadder(path, { FACTORY_CONFIG_PATH: path });
    expect(ladder.raw?.disk).toEqual({ minFreeGb: 2 });
  });

  it('FACTORY_CONFIG_OVERRIDES is merged over the container defaults by the run config ladder', () => {
    const path = writeDefaults();
    const ladder = resolveRunConfigLadder(path, {
      FACTORY_CONFIG_PATH: path,
      FACTORY_CONFIG_OVERRIDES: 'disk:\n  minFreeGb: 3\n',
    });
    expect(ladder.raw).toMatchObject({ sandbox: { runtime: 'none' }, disk: { minFreeGb: 3 } });
    expect(ladder.overrideKeys).toEqual(['disk.minFreeGb']);
  });

  it('FACTORY_CONFIG_OVERRIDES is merged over the repo config and leaves other keys', () => {
    const dir = tempDirs.makeSync('factory-job-repo-');
    mkdirSync(join(dir, '.factory'));
    const repoConfig = join(dir, '.factory', 'config.yaml');
    writeFileSync(repoConfig, 'version: 2\nsandbox:\n  runtime: none\ndisk:\n  minFreeGb: 10\n');
    const ladder = resolveRunConfigLadder(repoConfig, { FACTORY_CONFIG_OVERRIDES: 'disk:\n  minFreeGb: 2\n' });
    expect(ladder.raw).toMatchObject({ sandbox: { runtime: 'none' }, disk: { minFreeGb: 2 } });
    expect(readFileSync(repoConfig, 'utf8')).toContain('minFreeGb: 10');
  });
});

describe('jobChildArgs', () => {
  const flags: JobFlags = {
    repo: 'a/b',
    owner: 'a',
    name: 'b',
    issue: 5,
    mode: 'pr',
    workdir: '/w',
    factoryDir: undefined,
  };
  it('builds the run-issue argv for each mode', () => {
    expect(jobChildArgs(flags)).toEqual(['run-issue', '5', '--in-place', '--json']);
    expect(jobChildArgs({ ...flags, mode: 'merge' })).toEqual(['run-issue', '5', '--in-place', '--json', '--merge']);
    expect(jobChildArgs({ ...flags, mode: 'no-pr' })).toEqual(['run-issue', '5', '--in-place', '--json', '--no-pr']);
  });
});

describe('jobStatusLine', () => {
  const flags: JobFlags = {
    repo: 'a/b',
    owner: 'a',
    name: 'b',
    issue: 5,
    mode: 'merge',
    workdir: '/w',
    factoryDir: undefined,
  };
  const sources = { env: {}, writeContainerDefaults: false, configSource: 'c', constitutionSource: 'k' };
  const run = (outcome: RunResultJson['outcome']): RunResultJson => ({
    schemaVersion: 3,
    issue: 5,
    repo: 'a/b',
    outcome,
    exitReason: `ended ${outcome}`,
    pr: { number: 9, url: 'https://github.com/a/b/pull/9', state: 'merged' },
    branch: null,
    baseSha: null,
    headSha: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    phases: [],
    cost: { usd: 0, byModel: {} },
    reworkRounds: 0,
  });
  const input = { flags, sources, error: undefined, startedAt: 0, cloneMs: 10, runMs: 90, finishedAt: 100 };

  it('reports a merged run', () => {
    const line = jobStatusLine({ ...input, run: run('merged'), exitCode: 0 });
    expect(jobStatusJsonSchema.parse(line)).toEqual(line);
    expect(line).toMatchObject({
      merged: true,
      outcome: 'merged',
      exitReason: 'ended merged',
      pr: { number: 9, url: 'https://github.com/a/b/pull/9' },
      configSource: 'c',
      timings: { startedAt: '1970-01-01T00:00:00.000Z', cloneMs: 10, runMs: 90, totalMs: 100 },
    });
  });

  it('reports a parked run as not merged', () => {
    const line = jobStatusLine({ ...input, run: { ...run('parked'), pr: null }, exitCode: 1 });
    expect(line).toMatchObject({ merged: false, outcome: 'parked', pr: null, exitCode: 1 });
  });

  it('reports a failure with no result, preferring the error text', () => {
    const line = jobStatusLine({
      ...input,
      sources: undefined,
      run: undefined,
      exitCode: 2,
      error: 'boom',
      cloneMs: undefined,
      runMs: undefined,
    });
    expect(line).toMatchObject({ outcome: 'failed', exitReason: 'boom', configSource: null });
    expect(line.timings.cloneMs).toBeNull();
    expect(jobStatusLine({ ...input, run: undefined, exitCode: 2 }).exitReason).toBe('the run produced no result');
  });
});
