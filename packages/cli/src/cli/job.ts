// packages/cli/src/cli/job.ts — pure planning for `factory job`, the disposable-container entrypoint (#3902)
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

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

export interface JobConfigSources {
  /** Env additions for the child run. */
  env: Record<string, string>;
  writeContainerDefaults: boolean;
  configSource: string;
  constitutionSource: string;
}

/**
 * Config used when neither the caller nor the repo supplies one. The container is the sandbox, so no lane
 * sandbox runtime. The disk floor is 2 GB because the default Cloudflare container disk is 16 GB: the
 * packaged 10 GB floor would hold the run before it starts.
 */
export const CONTAINER_JOB_DEFAULTS = { version: 2, sandbox: { runtime: 'none' }, disk: { minFreeGb: 2 } } as const;

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_PATTERN = /^[1-9][0-9]*$/;

const blank = (v: string | undefined): v is undefined => v === undefined || v.trim() === '';

export function validateJobFlags(
  opts: { repo?: string; issue?: string; merge?: boolean; pr?: boolean; workdir?: string; factoryDir?: string },
  env: NodeJS.ProcessEnv = process.env,
): JobFlags {
  const repo = opts.repo ?? '';
  const [owner = '', name = ''] = repo.split('/');
  if (!REPO_PATTERN.test(repo) || [owner, name].some((part) => part === '.' || part === '..')) {
    throw new CliExitError('factory job: --repo must be <owner>/<name>', 2);
  }
  const issueText = opts.issue ?? '';
  if (!ISSUE_PATTERN.test(issueText)) throw new CliExitError('factory job: --issue must be a positive integer', 2);
  if (opts.merge === true && opts.pr === false) {
    throw new CliExitError('factory job: --merge and --no-pr are exclusive', 2);
  }
  const missing: string[] = [];
  if (blank(env.GH_TOKEN)) missing.push('GH_TOKEN');
  if (blank(env.CLAUDE_CODE_OAUTH_TOKEN) && blank(env.ANTHROPIC_API_KEY)) {
    missing.push('CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY');
  }
  if (missing.length > 0) throw new CliExitError(`factory job: missing required env: ${missing.join(', ')}`, 2);
  const home = blank(env.HOME) ? homedir() : env.HOME;
  const factoryDirRaw = opts.factoryDir ?? env.FACTORY_JOB_FACTORY_DIR;
  return {
    repo,
    owner,
    name,
    issue: Number(issueText),
    mode: opts.merge === true ? 'merge' : opts.pr === false ? 'no-pr' : 'pr',
    workdir: blank(opts.workdir) ? join(home, 'work') : resolve(opts.workdir),
    factoryDir: blank(factoryDirRaw) ? undefined : resolve(factoryDirRaw),
  };
}

export function resolveJobConfigSources(
  input: {
    cloneDir: string;
    factoryDir: string | undefined;
    containerDefaultsPath: string;
    exists: (path: string) => boolean;
  },
  env: NodeJS.ProcessEnv,
): JobConfigSources {
  const { cloneDir, factoryDir, containerDefaultsPath, exists } = input;
  const additions: Record<string, string> = {};
  let writeContainerDefaults = false;
  let configSource: string;
  let constitutionSource: string;

  const mountedConfig = factoryDir === undefined ? undefined : resolveRepoConfigPath(factoryDir);
  const mountedConfigExists = mountedConfig !== undefined && exists(mountedConfig);
  const mountedConstitution = factoryDir === undefined ? undefined : join(factoryDir, 'constitution.md');
  const mountedConstitutionExists = mountedConstitution !== undefined && exists(mountedConstitution);
  if (factoryDir !== undefined && !mountedConfigExists && !mountedConstitutionExists) {
    throw new CliExitError(`factory job: --factory-dir ${factoryDir} has no config file or constitution.md`, 2);
  }

  const repoConfig = resolveRepoConfigPath(join(cloneDir, '.factory'));
  if (!blank(env.FACTORY_CONFIG_PATH)) {
    const label = env.FACTORY_CONFIG_PATH_SOURCE === '--config' ? '--config' : 'FACTORY_CONFIG_PATH';
    configSource = `${label} (${env.FACTORY_CONFIG_PATH})`;
  } else if (mountedConfigExists) {
    additions.FACTORY_CONFIG_PATH = mountedConfig;
    configSource = `mounted .factory dir (${mountedConfig})`;
  } else if (!blank(env.FACTORY_CONFIG_YAML)) {
    configSource = 'FACTORY_CONFIG_YAML';
  } else if (exists(repoConfig)) {
    configSource = `repo .factory/${basename(repoConfig)}`;
  } else {
    writeContainerDefaults = true;
    additions.FACTORY_CONFIG_PATH = containerDefaultsPath;
    configSource = 'container defaults';
  }
  if (!blank(env.FACTORY_CONFIG_OVERRIDES)) configSource += '; overrides: FACTORY_CONFIG_OVERRIDES';

  if (!blank(env.FACTORY_CONSTITUTION_PATH)) {
    const label =
      env.FACTORY_CONSTITUTION_PATH_SOURCE === '--constitution' ? '--constitution' : 'FACTORY_CONSTITUTION_PATH';
    constitutionSource = `${label} (${env.FACTORY_CONSTITUTION_PATH})`;
  } else if (mountedConstitutionExists) {
    additions.FACTORY_CONSTITUTION_PATH = mountedConstitution;
    constitutionSource = `mounted .factory dir (${mountedConstitution})`;
  } else if (!blank(env.FACTORY_CONSTITUTION)) {
    constitutionSource = 'FACTORY_CONSTITUTION';
  } else if (exists(join(cloneDir, '.factory', 'constitution.md'))) {
    constitutionSource = 'repo .factory/constitution.md';
  } else {
    constitutionSource = 'repo instruction files / bundled';
  }

  return { env: additions, writeContainerDefaults, configSource, constitutionSource };
}

export function jobChildArgs(flags: JobFlags): string[] {
  const modeArgs = flags.mode === 'merge' ? ['--merge'] : flags.mode === 'no-pr' ? ['--no-pr'] : [];
  return ['run-issue', String(flags.issue), '--in-place', '--json', ...modeArgs];
}

export function jobStatusLine(input: {
  flags: JobFlags;
  sources: JobConfigSources | undefined;
  run: RunResultJson | undefined;
  exitCode: number;
  error: string | undefined;
  startedAt: number;
  cloneMs: number | undefined;
  runMs: number | undefined;
  finishedAt: number;
}): JobStatusJson {
  const { flags, sources, run, exitCode, error, startedAt, cloneMs, runMs, finishedAt } = input;
  return {
    schemaVersion: 1,
    kind: 'factory-job',
    repo: flags.repo,
    issue: flags.issue,
    outcome: run?.outcome ?? 'failed',
    merged: run?.outcome === 'merged',
    exitReason: error ?? run?.exitReason ?? 'the run produced no result',
    exitCode,
    pr: run?.pr ? { number: run.pr.number, url: run.pr.url } : null,
    configSource: sources?.configSource ?? null,
    constitutionSource: sources?.constitutionSource ?? null,
    timings: {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      cloneMs: cloneMs ?? null,
      runMs: runMs ?? null,
      totalMs: finishedAt - startedAt,
    },
  };
}
