// packages/cli/src/cli/job.ts — pure planner for `factory job`, the one-shot container entrypoint (#3902).
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveRepoConfigPath } from '@on-par/factory-core/internal';

import { CliExitError } from './errors.js';
import type { JobStatusJson } from './job-status-contract.js';
import type { RunResultJson } from './json-contract.js';

export interface JobFlags {
  repo: string;
  owner: string;
  name: string;
  issue: number;
  mode: 'merge' | 'no-pr' | 'pr';
  workdir: string;
  factoryDir: string | undefined;
}

export interface JobCommandInput {
  repo?: string;
  issue?: string;
  merge?: boolean;
  pr?: boolean;
  workdir?: string;
  factoryDir?: string;
}

/**
 * Config used when nothing else supplies one. The container is the sandbox, so lane sandboxes are off.
 * Jobs run on 16 GB containers: the default 10 GB disk floor would hold every job there, so the floor is 2 GB.
 */
export const CONTAINER_JOB_DEFAULTS = { version: 2, sandbox: { runtime: 'none' }, disk: { minFreeGb: 2 } } as const;

export interface JobConfigSources {
  env: Record<string, string>;
  writeContainerDefaults: boolean;
  configSource: string;
  constitutionSource: string;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_PATTERN = /^[1-9][0-9]*$/;

const blank = (v: string | undefined): v is undefined => v === undefined || v.trim() === '';

function fail(message: string): never {
  throw new CliExitError(`factory job: ${message}`, 2);
}

/** Validate the flags and the secrets' presence (never their values). Throws CliExitError(2). */
export function validateJobFlags(opts: JobCommandInput, env: NodeJS.ProcessEnv = process.env): JobFlags {
  const repo = opts.repo ?? '';
  const [owner = '', name = ''] = repo.split('/');
  if (!REPO_PATTERN.test(repo) || [owner, name].some((part) => part === '.' || part === '..')) {
    fail('--repo must be <owner>/<name>');
  }
  if (!ISSUE_PATTERN.test(opts.issue ?? '')) fail('--issue must be a positive integer');
  const issue = Number(opts.issue);
  if (!Number.isSafeInteger(issue)) fail('--issue must be a positive integer');
  if (opts.merge === true && opts.pr === false) fail('--merge and --no-pr are exclusive');
  const missing: string[] = [];
  if (blank(env.GH_TOKEN)) missing.push('GH_TOKEN');
  if (blank(env.CLAUDE_CODE_OAUTH_TOKEN) && blank(env.ANTHROPIC_API_KEY)) {
    missing.push('CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY');
  }
  if (missing.length > 0) fail(`missing required environment: ${missing.join(', ')}`);
  const home = blank(env.HOME) ? homedir() : env.HOME;
  const factoryDirRaw = opts.factoryDir ?? env.FACTORY_JOB_FACTORY_DIR;
  return {
    repo,
    owner,
    name,
    issue,
    mode: opts.merge === true ? 'merge' : opts.pr === false ? 'no-pr' : 'pr',
    workdir: resolve(opts.workdir ?? join(home, 'work')),
    factoryDir: blank(factoryDirRaw) ? undefined : resolve(factoryDirRaw),
  };
}

interface ResolveInput {
  cloneDir: string;
  factoryDir: string | undefined;
  containerDefaultsPath: string;
  exists: (path: string) => boolean;
}

/** Pick the config and constitution source in the documented order and name them for the log. */
export function resolveJobConfigSources(input: ResolveInput, env: NodeJS.ProcessEnv): JobConfigSources {
  const { cloneDir, factoryDir, containerDefaultsPath, exists } = input;
  const extra: Record<string, string> = {};
  let writeContainerDefaults = false;
  let configSource: string;
  let constitutionSource: string;

  const mountedConfig = factoryDir === undefined ? undefined : resolveRepoConfigPath(factoryDir);
  const mountedConfigFound = mountedConfig !== undefined && exists(mountedConfig);
  const mountedConstitution = factoryDir === undefined ? undefined : join(factoryDir, 'constitution.md');
  const mountedConstitutionFound = mountedConstitution !== undefined && exists(mountedConstitution);
  if (factoryDir !== undefined && !mountedConfigFound && !mountedConstitutionFound) {
    fail(`--factory-dir ${factoryDir} has no config file or constitution.md`);
  }

  const repoConfig = resolveRepoConfigPath(join(cloneDir, '.factory'));
  if (!blank(env.FACTORY_CONFIG_PATH)) {
    const label = env.FACTORY_CONFIG_PATH_SOURCE === '--config' ? '--config' : 'FACTORY_CONFIG_PATH';
    configSource = `${label} (${env.FACTORY_CONFIG_PATH})`;
  } else if (mountedConfigFound) {
    extra.FACTORY_CONFIG_PATH = mountedConfig;
    configSource = `mounted .factory dir (${mountedConfig})`;
  } else if (!blank(env.FACTORY_CONFIG_YAML)) {
    configSource = 'FACTORY_CONFIG_YAML';
  } else if (exists(repoConfig)) {
    configSource = `repo .factory/${repoConfig.split(/[\\/]/).pop()}`;
  } else {
    writeContainerDefaults = true;
    extra.FACTORY_CONFIG_PATH = containerDefaultsPath;
    configSource = 'container defaults';
  }

  const clonedConstitution = join(cloneDir, '.factory', 'constitution.md');
  if (!blank(env.FACTORY_CONSTITUTION_PATH)) {
    const label =
      env.FACTORY_CONSTITUTION_PATH_SOURCE === '--constitution' ? '--constitution' : 'FACTORY_CONSTITUTION_PATH';
    constitutionSource = `${label} (${env.FACTORY_CONSTITUTION_PATH})`;
  } else if (mountedConstitutionFound) {
    extra.FACTORY_CONSTITUTION_PATH = mountedConstitution;
    constitutionSource = `mounted .factory dir (${mountedConstitution})`;
  } else if (!blank(env.FACTORY_CONSTITUTION)) {
    constitutionSource = 'FACTORY_CONSTITUTION';
  } else if (exists(clonedConstitution)) {
    constitutionSource = 'repo .factory/constitution.md';
  } else {
    constitutionSource = 'repo instruction files / bundled';
  }

  if (!blank(env.FACTORY_CONFIG_OVERRIDES)) configSource += '; overrides: FACTORY_CONFIG_OVERRIDES';
  return { env: extra, writeContainerDefaults, configSource, constitutionSource };
}

/** argv (after the factory entry script) for the child `run-issue` run. */
export function jobChildArgs(flags: JobFlags): string[] {
  const modeArgs = flags.mode === 'merge' ? ['--merge'] : flags.mode === 'no-pr' ? ['--no-pr'] : [];
  return ['run-issue', String(flags.issue), '--in-place', '--json', ...modeArgs];
}

export interface JobStatusInput {
  flags: JobFlags;
  sources: JobConfigSources | undefined;
  run: RunResultJson | undefined;
  exitCode: number;
  error: string | undefined;
  startedAt: number;
  cloneMs: number | undefined;
  runMs: number | undefined;
  finishedAt: number;
}

/** The final JSON status line `factory job` prints. */
export function jobStatusLine(input: JobStatusInput): JobStatusJson {
  const { flags, sources, run, startedAt, finishedAt } = input;
  return {
    schemaVersion: 1,
    kind: 'factory-job',
    repo: flags.repo,
    issue: flags.issue,
    outcome: run?.outcome ?? 'failed',
    merged: run?.outcome === 'merged',
    exitReason: input.error ?? run?.exitReason ?? 'the run produced no result',
    exitCode: input.exitCode,
    pr: run?.pr ? { number: run.pr.number, url: run.pr.url } : null,
    configSource: sources?.configSource ?? 'unresolved',
    constitutionSource: sources?.constitutionSource ?? 'unresolved',
    timings: {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      cloneMs: input.cloneMs ?? null,
      runMs: input.runMs ?? null,
      totalMs: finishedAt - startedAt,
    },
  };
}
