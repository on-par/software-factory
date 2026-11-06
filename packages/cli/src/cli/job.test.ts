import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

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

const ENV = { GH_TOKEN: 'ghp_x', CLAUDE_CODE_OAUTH_TOKEN: 'sk-x', HOME: '/home/node' };
const OPTS = { repo: 'on-par/foreman', issue: '12' };

function exitCodeOf(fn: () => unknown): { code: number; message: string } {
  try {
    fn();
  } catch (err) {
    return { code: (err as { code: number }).code, message: (err as Error).message };
  }
  throw new Error('did not throw');
}

describe('validateJobFlags', () => {
  it('accepts a valid repo and issue and defaults the workdir under HOME', () => {
    expect(validateJobFlags(OPTS, ENV)).toEqual({
      repo: 'on-par/foreman',
      owner: 'on-par',
      name: 'foreman',
      issue: 12,
      mode: 'pr',
      workdir: '/home/node/work',
      factoryDir: undefined,
    });
  });

  it.each(['..', 'a/b/c', 'https://github.com/a/b', 'a', 'a/..', './b', 'a b/c', ''])('rejects repo %j', (repo) => {
    expect(exitCodeOf(() => validateJobFlags({ ...OPTS, repo }, ENV))).toMatchObject({ code: 2 });
  });

  it.each(['0', '01', '3x', '-1', '', '1.5'])('rejects issue %j', (issue) => {
    expect(exitCodeOf(() => validateJobFlags({ ...OPTS, issue }, ENV))).toMatchObject({ code: 2 });
  });

  it('rejects an unsafe integer issue', () => {
    expect(exitCodeOf(() => validateJobFlags({ ...OPTS, issue: '99999999999999999999' }, ENV)).code).toBe(2);
  });

  it('maps --merge and --no-pr to a mode and rejects both together', () => {
    expect(validateJobFlags({ ...OPTS, merge: true }, ENV).mode).toBe('merge');
    expect(validateJobFlags({ ...OPTS, pr: false }, ENV).mode).toBe('no-pr');
    expect(exitCodeOf(() => validateJobFlags({ ...OPTS, merge: true, pr: false }, ENV))).toMatchObject({
      code: 2,
      message: expect.stringContaining('exclusive'),
    });
  });

  it('names a missing GH_TOKEN, and blank values count as missing', () => {
    const { message } = exitCodeOf(() => validateJobFlags(OPTS, { ...ENV, GH_TOKEN: '  ' }));
    expect(message).toContain('GH_TOKEN');
  });

  it('requires one of the agent tokens', () => {
    const env = { GH_TOKEN: 'x', HOME: '/h' };
    expect(exitCodeOf(() => validateJobFlags(OPTS, env)).message).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(validateJobFlags(OPTS, { ...env, ANTHROPIC_API_KEY: 'k' }).issue).toBe(12);
  });

  it('never echoes secret values', () => {
    const { message } = exitCodeOf(() =>
      validateJobFlags({ ...OPTS, repo: 'bad' }, { ...ENV, GH_TOKEN: 'ghp_SECRET' }),
    );
    expect(message).not.toContain('ghp_SECRET');
  });

  it('resolves workdir and factory dir, with the env fallback for the factory dir', () => {
    const flags = validateJobFlags({ ...OPTS, workdir: 'w' }, { ...ENV, FACTORY_JOB_FACTORY_DIR: '/mnt/f' });
    expect(flags.workdir).toMatch(/^\/.*\/w$/);
    expect(flags.factoryDir).toBe('/mnt/f');
    expect(
      validateJobFlags({ ...OPTS, factoryDir: '/x' }, { ...ENV, FACTORY_JOB_FACTORY_DIR: '/mnt/f' }).factoryDir,
    ).toBe('/x');
    expect(validateJobFlags(OPTS, { ...ENV, FACTORY_JOB_FACTORY_DIR: ' ' }).factoryDir).toBeUndefined();
  });
});

function layout(files: string[]): { clone: string; factory: string; exists: (p: string) => boolean } {
  const root = tempDirs.makeSync('factory-job-');
  const clone = join(root, 'clone');
  const factory = join(root, 'mounted');
  mkdirSync(join(clone, '.factory'), { recursive: true });
  mkdirSync(factory, { recursive: true });
  for (const f of files) writeFileSync(join(root, f), 'x');
  return { clone, factory, exists: (p) => files.some((f) => join(root, f) === p) };
}

const DEFAULTS_PATH = '/work/.factory-job/container-defaults.yaml';

describe('resolveJobConfigSources', () => {
  it("uses the repo's committed .factory/config.yaml when no override is set", () => {
    const l = layout(['clone/.factory/config.yaml']);
    const out = resolveJobConfigSources(
      { cloneDir: l.clone, factoryDir: undefined, containerDefaultsPath: DEFAULTS_PATH, exists: l.exists },
      {},
    );
    expect(out).toMatchObject({ configSource: 'repo .factory/config.yaml', writeContainerDefaults: false, env: {} });
  });

  it('names the config and constitution source in the log line', () => {
    const l = layout(['clone/.factory/config.yaml', 'clone/.factory/constitution.md']);
    const out = resolveJobConfigSources(
      { cloneDir: l.clone, factoryDir: undefined, containerDefaultsPath: DEFAULTS_PATH, exists: l.exists },
      {},
    );
    expect(out.configSource).toBe('repo .factory/config.yaml');
    expect(out.constitutionSource).toBe('repo .factory/constitution.md');
  });

  it('FACTORY_CONFIG_YAML wins over the repo config', () => {
    const l = layout(['clone/.factory/config.yaml']);
    const out = resolveJobConfigSources(
      { cloneDir: l.clone, factoryDir: undefined, containerDefaultsPath: DEFAULTS_PATH, exists: l.exists },
      { FACTORY_CONFIG_YAML: 'version: 2' },
    );
    expect(out.configSource).toBe('FACTORY_CONFIG_YAML');
    expect(out.writeContainerDefaults).toBe(false);
  });

  it('a mounted .factory dir wins over FACTORY_CONFIG_YAML and the repo config', () => {
    const l = layout(['clone/.factory/config.yaml', 'mounted/config.yaml', 'mounted/constitution.md']);
    const out = resolveJobConfigSources(
      { cloneDir: l.clone, factoryDir: l.factory, containerDefaultsPath: DEFAULTS_PATH, exists: l.exists },
      { FACTORY_CONFIG_YAML: 'version: 2', FACTORY_CONSTITUTION: 'c' },
    );
    expect(out.env).toEqual({
      FACTORY_CONFIG_PATH: join(l.factory, 'config.yaml'),
      FACTORY_CONSTITUTION_PATH: join(l.factory, 'constitution.md'),
    });
    expect(out.configSource).toBe(`mounted .factory dir (${join(l.factory, 'config.yaml')})`);
    expect(out.constitutionSource).toBe(`mounted .factory dir (${join(l.factory, 'constitution.md')})`);
  });

  it('--config wins over every other source', () => {
    const l = layout(['mounted/config.yaml']);
    const out = resolveJobConfigSources(
      { cloneDir: l.clone, factoryDir: l.factory, containerDefaultsPath: DEFAULTS_PATH, exists: l.exists },
      { FACTORY_CONFIG_PATH: '/c.yaml', FACTORY_CONFIG_PATH_SOURCE: '--config', FACTORY_CONFIG_YAML: 'x' },
    );
    expect(out.configSource).toBe('--config (/c.yaml)');
    expect(out.env).toEqual({});
  });

  it('labels a plain FACTORY_CONFIG_PATH and the constitution path variants', () => {
    const l = layout([]);
    const base = { cloneDir: l.clone, factoryDir: undefined, containerDefaultsPath: DEFAULTS_PATH, exists: l.exists };
    expect(resolveJobConfigSources(base, { FACTORY_CONFIG_PATH: '/c.yaml' }).configSource).toBe(
      'FACTORY_CONFIG_PATH (/c.yaml)',
    );
    expect(
      resolveJobConfigSources(base, {
        FACTORY_CONSTITUTION_PATH: '/k.md',
        FACTORY_CONSTITUTION_PATH_SOURCE: '--constitution',
      }).constitutionSource,
    ).toBe('--constitution (/k.md)');
    expect(resolveJobConfigSources(base, { FACTORY_CONSTITUTION_PATH: '/k.md' }).constitutionSource).toBe(
      'FACTORY_CONSTITUTION_PATH (/k.md)',
    );
    expect(resolveJobConfigSources(base, { FACTORY_CONSTITUTION: 'text' }).constitutionSource).toBe(
      'FACTORY_CONSTITUTION',
    );
  });

  it('falls back to container defaults and bundled constitution', () => {
    const l = layout([]);
    const out = resolveJobConfigSources(
      { cloneDir: l.clone, factoryDir: undefined, containerDefaultsPath: DEFAULTS_PATH, exists: l.exists },
      {},
    );
    expect(out).toEqual({
      env: { FACTORY_CONFIG_PATH: DEFAULTS_PATH },
      writeContainerDefaults: true,
      configSource: 'container defaults',
      constitutionSource: 'repo instruction files / bundled',
    });
  });

  it('rejects a mounted dir with neither a config file nor constitution.md', () => {
    const l = layout([]);
    expect(
      exitCodeOf(() =>
        resolveJobConfigSources(
          { cloneDir: l.clone, factoryDir: l.factory, containerDefaultsPath: DEFAULTS_PATH, exists: l.exists },
          {},
        ),
      ),
    ).toMatchObject({ code: 2, message: expect.stringContaining('no config file or constitution.md') });
  });

  it('a mounted dir with only a constitution leaves the config ladder to the lower rungs', () => {
    const l = layout(['mounted/constitution.md']);
    const out = resolveJobConfigSources(
      { cloneDir: l.clone, factoryDir: l.factory, containerDefaultsPath: DEFAULTS_PATH, exists: l.exists },
      {},
    );
    expect(out.configSource).toBe('container defaults');
    expect(out.env.FACTORY_CONSTITUTION_PATH).toBe(join(l.factory, 'constitution.md'));
  });

  it('flags FACTORY_CONFIG_OVERRIDES in the config label without printing its content', () => {
    const l = layout(['clone/.factory/config.yaml']);
    const out = resolveJobConfigSources(
      { cloneDir: l.clone, factoryDir: undefined, containerDefaultsPath: DEFAULTS_PATH, exists: l.exists },
      { FACTORY_CONFIG_OVERRIDES: 'disk:\n  minFreeGb: 2\n' },
    );
    expect(out.configSource).toBe('repo .factory/config.yaml; overrides: FACTORY_CONFIG_OVERRIDES');
  });
});

describe('container defaults', () => {
  it('container defaults set sandbox.runtime none and a 2 GiB disk floor when the repo has no config', () => {
    const parsed = YAML.parse(YAML.stringify(CONTAINER_JOB_DEFAULTS)) as typeof CONTAINER_JOB_DEFAULTS;
    expect(parsed).toEqual({ version: 2, sandbox: { runtime: 'none' }, disk: { minFreeGb: 2 } });
    expect(parsed.disk.minFreeGb).toBeLessThan(16);
  });
});

describe('jobChildArgs', () => {
  const base: JobFlags = {
    repo: 'a/b',
    owner: 'a',
    name: 'b',
    issue: 7,
    mode: 'pr',
    workdir: '/w',
    factoryDir: undefined,
  };
  it('builds argv per mode', () => {
    expect(jobChildArgs(base)).toEqual(['run-issue', '7', '--in-place', '--json']);
    expect(jobChildArgs({ ...base, mode: 'merge' })).toEqual(['run-issue', '7', '--in-place', '--json', '--merge']);
    expect(jobChildArgs({ ...base, mode: 'no-pr' })).toEqual(['run-issue', '7', '--in-place', '--json', '--no-pr']);
  });
});

describe('jobStatusLine', () => {
  const flags: JobFlags = {
    repo: 'a/b',
    owner: 'a',
    name: 'b',
    issue: 7,
    mode: 'merge',
    workdir: '/w',
    factoryDir: undefined,
  };
  const sources = {
    env: {},
    writeContainerDefaults: false,
    configSource: 'cfg',
    constitutionSource: 'con',
  };
  const run = (outcome: RunResultJson['outcome'], pr: RunResultJson['pr']): RunResultJson => ({
    schemaVersion: 3,
    issue: 7,
    repo: 'a/b',
    outcome,
    exitReason: `reason ${outcome}`,
    pr,
    branch: null,
    baseSha: null,
    headSha: null,
    startedAt: 's',
    finishedAt: 'f',
    phases: [],
    cost: { usd: 0, byModel: {} },
    reworkRounds: 0,
  });
  const input = { flags, sources, startedAt: 1000, cloneMs: 5, runMs: 20, finishedAt: 4000, error: undefined };

  it('reports a merged run with PR and timings', () => {
    const line = jobStatusLine({
      ...input,
      run: run('merged', { number: 9, url: 'https://x/9', state: 'merged' }),
      exitCode: 0,
    });
    expect(jobStatusJsonSchema.parse(line)).toEqual(line);
    expect(line).toMatchObject({
      merged: true,
      outcome: 'merged',
      exitCode: 0,
      pr: { number: 9, url: 'https://x/9' },
      configSource: 'cfg',
      timings: { cloneMs: 5, runMs: 20, totalMs: 3000 },
    });
  });

  it('reports a parked run as not merged with no PR', () => {
    const line = jobStatusLine({ ...input, run: run('parked', null), exitCode: 1 });
    expect(line).toMatchObject({ merged: false, outcome: 'parked', exitReason: 'reason parked', pr: null });
  });

  it('reports no result as failed, with the error as the reason and unreached timings null', () => {
    const line = jobStatusLine({
      ...input,
      sources: undefined,
      run: undefined,
      exitCode: 2,
      error: 'boom',
      cloneMs: undefined,
      runMs: undefined,
    });
    expect(jobStatusJsonSchema.parse(line)).toEqual(line);
    expect(line).toMatchObject({ outcome: 'failed', exitReason: 'boom', timings: { cloneMs: null, runMs: null } });
    expect(jobStatusLine({ ...input, run: undefined, exitCode: 1, error: undefined }).exitReason).toBe(
      'the run produced no result',
    );
  });
});
