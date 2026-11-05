// packages/cli/src/cli/job-command.ts — `factory job`: bootstrap a fresh container, clone, run one issue in place (#3902)
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CliExitError } from './errors.js';
import {
  CONTAINER_JOB_DEFAULTS,
  jobChildArgs,
  jobStatusLine,
  resolveJobConfigSources,
  validateJobFlags,
  type JobConfigSources,
  type JobFlags,
} from './job.js';
import { runResultJsonSchema, type RunResultJson } from './json-contract.js';

export interface JobCommandOptions {
  repo?: string;
  issue?: string;
  merge?: boolean;
  pr?: boolean;
  workdir?: string;
  factoryDir?: string;
}

export interface JobRunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
}

export interface JobDeps {
  env: NodeJS.ProcessEnv;
  run(
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv; captureStdout?: boolean },
  ): Promise<JobRunResult>;
  exists(path: string): boolean;
  /** True when `path` is a directory with at least one entry. */
  isNonEmptyDir(path: string): boolean;
  mkdir(path: string): void;
  writeFile(path: string, text: string, mode: number): void;
  appendFile(path: string, text: string): void;
  now(): number;
  stdout(line: string): void;
  log(line: string): void;
  cliEntry: { node: string; script: string };
}

const GIT_NAME = 'Software Factory Job';
const GIT_EMAIL = 'factory-job[bot]@users.noreply.github.com';

class JobSetupError extends Error {}

/** Last non-empty line of the child's stdout as a run result, or undefined when absent or invalid. */
function parseRunResult(stdout: string): RunResultJson | undefined {
  const last = stdout
    .split('\n')
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.length > 0);
  if (last === undefined) return undefined;
  try {
    const parsed = runResultJsonSchema.safeParse(JSON.parse(last));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function runChecked(deps: JobDeps, what: string, cmd: string, args: string[], cwd?: string): Promise<void> {
  const result = await deps.run(cmd, args, cwd === undefined ? {} : { cwd });
  if (result.code !== 0) throw new JobSetupError(`${what} failed (exit ${result.code ?? result.signal ?? 'unknown'})`);
}

async function setGitIdentityIfUnset(deps: JobDeps, cloneDir: string): Promise<void> {
  for (const [key, value] of [
    ['user.name', GIT_NAME],
    ['user.email', GIT_EMAIL],
  ] as const) {
    const current = await deps.run('git', ['config', key], { cwd: cloneDir, captureStdout: true });
    if (current.code !== 0 || current.stdout.trim() === '') {
      await runChecked(deps, `git config ${key}`, 'git', ['config', key, value], cloneDir);
    }
  }
}

/** Keeps the factory's own files out of the clone's status and makes run-issue's initialized check pass. */
function prepareFactoryDir(deps: JobDeps, cloneDir: string): void {
  const factoryDir = join(cloneDir, '.factory');
  const excludes = ['/.factory/state/'];
  if (!deps.exists(factoryDir)) excludes.push('/.factory/');
  deps.mkdir(join(cloneDir, '.git', 'info'));
  deps.appendFile(join(cloneDir, '.git', 'info', 'exclude'), `${excludes.join('\n')}\n`);
  if (!deps.exists(factoryDir)) deps.mkdir(factoryDir);
}

/** Runs one job; returns the exit code. Always prints exactly one status line on stdout. */
export async function runJob(opts: JobCommandOptions, deps: JobDeps): Promise<number> {
  const startedAt = deps.now();
  let flags: JobFlags | undefined;
  let sources: JobConfigSources | undefined;
  let cloneMs: number | undefined;
  let runMs: number | undefined;
  let run: RunResultJson | undefined;
  let exitCode = 2;
  let error: string | undefined;
  try {
    flags = validateJobFlags(opts, deps.env);
    if (process.getuid?.() === 0) {
      deps.log('factory job: warning: running as root; Claude Code refuses --dangerously-skip-permissions as root');
    }
    await runChecked(deps, 'gh auth setup-git', 'gh', ['auth', 'setup-git']);
    const home = deps.env.HOME?.trim() ? deps.env.HOME : homedir();
    const claudeState = join(home, '.claude.json');
    if (!deps.exists(claudeState)) deps.writeFile(claudeState, '{"hasCompletedOnboarding":true}\n', 0o600);

    deps.mkdir(flags.workdir);
    const cloneDir = join(flags.workdir, flags.name);
    if (deps.isNonEmptyDir(cloneDir))
      throw new JobSetupError(`clone directory ${cloneDir} already exists and is not empty`);
    const cloneStart = deps.now();
    await runChecked(deps, 'git clone', 'git', [
      'clone',
      `https://github.com/${flags.owner}/${flags.name}.git`,
      cloneDir,
    ]);
    cloneMs = deps.now() - cloneStart;

    await setGitIdentityIfUnset(deps, cloneDir);
    prepareFactoryDir(deps, cloneDir);

    const containerDefaultsPath = join(flags.workdir, '.factory-job', 'container-defaults.yaml');
    sources = resolveJobConfigSources(
      { cloneDir, factoryDir: flags.factoryDir, containerDefaultsPath, exists: (p) => deps.exists(p) },
      deps.env,
    );
    if (sources.writeContainerDefaults) {
      deps.mkdir(join(flags.workdir, '.factory-job'));
      // JSON is valid YAML, so the config loader reads this without a YAML writer dependency.
      deps.writeFile(containerDefaultsPath, `${JSON.stringify(CONTAINER_JOB_DEFAULTS, null, 2)}\n`, 0o600);
    }
    deps.log(`factory job: config source: ${sources.configSource}; constitution source: ${sources.constitutionSource}`);

    const runStart = deps.now();
    const child = await deps.run(deps.cliEntry.node, [deps.cliEntry.script, ...jobChildArgs(flags)], {
      cwd: cloneDir,
      env: { ...deps.env, ...sources.env },
      captureStdout: true,
    });
    runMs = deps.now() - runStart;
    run = parseRunResult(child.stdout);
    if (child.signal !== null) {
      exitCode = 1;
      error = `killed by ${child.signal}`;
    } else if (child.code === 0 && run === undefined) {
      error = 'run-issue exited 0 without a valid result line';
    } else {
      exitCode = child.code ?? 1;
    }
  } catch (err) {
    exitCode = err instanceof CliExitError ? err.code : 2;
    error = err instanceof JobSetupError || err instanceof CliExitError ? err.message : 'unexpected setup error';
    deps.log(error.startsWith('factory job:') ? error : `factory job: ${error}`);
  }
  const statusFlags: JobFlags = flags ?? {
    repo: opts.repo ?? '',
    owner: '',
    name: '',
    issue: Number.isInteger(Number(opts.issue)) ? Number(opts.issue) : 0,
    mode: 'pr',
    workdir: '',
    factoryDir: undefined,
  };
  deps.stdout(
    JSON.stringify(
      jobStatusLine({
        flags: statusFlags,
        sources,
        run,
        exitCode,
        error,
        startedAt,
        cloneMs,
        runMs,
        finishedAt: deps.now(),
      }),
    ),
  );
  return exitCode;
}

function spawnCollect(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; captureStdout?: boolean },
): Promise<JobRunResult> {
  return new Promise((resolvePromise, reject) => {
    const capture = opts.captureStdout === true;
    const child = spawn(cmd, args, {
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      ...(opts.env === undefined ? {} : { env: opts.env }),
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout }));
  });
}

export function createJobDeps(): JobDeps {
  return {
    env: process.env,
    run: spawnCollect,
    exists: existsSync,
    isNonEmptyDir: (p) => existsSync(p) && readdirSync(p).length > 0,
    mkdir: (p) => {
      mkdirSync(p, { recursive: true });
    },
    writeFile: (p, text, mode) => {
      writeFileSync(p, text, { mode });
    },
    appendFile: (p, text) => {
      appendFileSync(p, text);
    },
    now: () => Date.now(),
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    log: (line) => {
      process.stderr.write(`${line}\n`);
    },
    cliEntry: { node: process.execPath, script: process.argv[1] ?? '' },
  };
}

export async function cmdJob(opts: JobCommandOptions): Promise<void> {
  const code = await runJob(opts, createJobDeps());
  if (code !== 0) throw new CliExitError('', code);
}
