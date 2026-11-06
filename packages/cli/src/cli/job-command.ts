// packages/cli/src/cli/job-command.ts — `factory job`: bootstrap a fresh container, run one issue in place (#3902).
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import YAML from 'yaml';

import { CliExitError } from './errors.js';
import {
  CONTAINER_JOB_DEFAULTS,
  jobChildArgs,
  jobStatusLine,
  resolveJobConfigSources,
  validateJobFlags,
  type JobCommandInput,
  type JobConfigSources,
  type JobFlags,
} from './job.js';
import { runResultJsonSchema, type RunResultJson } from './json-contract.js';

export type JobCommandOptions = JobCommandInput;

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
  exists(p: string): boolean;
  isEmptyDir(p: string): boolean;
  mkdir(p: string): void;
  writeFile(p: string, text: string, mode: number): void;
  appendFile(p: string, text: string): void;
  readFile(p: string): string;
  now(): number;
  stdout(line: string): void;
  log(line: string): void;
  cliEntry: { node: string; script: string };
}

const SETUP_FAILED = 2;
const GIT_USER_NAME = 'Software Factory Job';
const GIT_USER_EMAIL = 'factory-job[bot]@users.noreply.github.com';

/** Last non-empty stdout line parsed as a run result; undefined when absent or invalid. */
function parseRunResult(stdout: string): RunResultJson | undefined {
  const last = stdout
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l !== '');
  if (last === undefined) return undefined;
  try {
    const parsed = runResultJsonSchema.safeParse(JSON.parse(last));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function ensureGitIdentity(deps: JobDeps, cloneDir: string): Promise<void> {
  const settings: Array<[string, string]> = [
    ['user.name', GIT_USER_NAME],
    ['user.email', GIT_USER_EMAIL],
  ];
  for (const [key, value] of settings) {
    const current = await deps.run('git', ['config', key], { cwd: cloneDir, env: deps.env, captureStdout: true });
    if (current.code !== 0 || current.stdout.trim() === '') {
      await deps.run('git', ['config', key, value], { cwd: cloneDir, env: deps.env });
    }
  }
}

function prepareCloneDir(deps: JobDeps, cloneDir: string): void {
  deps.appendFile(join(cloneDir, '.git', 'info', 'exclude'), '/.factory/state/\n');
  const factoryDir = join(cloneDir, '.factory');
  if (!deps.exists(factoryDir)) {
    deps.appendFile(join(cloneDir, '.git', 'info', 'exclude'), '/.factory/\n');
    deps.mkdir(factoryDir);
  }
}

interface Bootstrapped {
  cloneDir: string;
  cloneMs: number;
}

async function bootstrap(deps: JobDeps, flags: JobFlags): Promise<Bootstrapped> {
  const home = deps.env.HOME ?? '';
  if (process.getuid?.() === 0) {
    deps.log('factory job: warning: running as root; Claude Code refuses skip-permissions as root');
  }
  const auth = await deps.run('gh', ['auth', 'setup-git'], { env: deps.env });
  if (auth.code !== 0) throw new Error('gh auth setup-git failed');
  const claudeJson = join(home, '.claude.json');
  if (!deps.exists(claudeJson)) deps.writeFile(claudeJson, '{"hasCompletedOnboarding":true}\n', 0o600);
  deps.mkdir(flags.workdir);
  const cloneDir = join(flags.workdir, flags.name);
  if (deps.exists(cloneDir) && !deps.isEmptyDir(cloneDir)) {
    throw new Error(`clone directory ${cloneDir} already exists and is not empty`);
  }
  const cloneStart = deps.now();
  const clone = await deps.run('git', ['clone', `https://github.com/${flags.owner}/${flags.name}.git`, cloneDir], {
    env: deps.env,
  });
  if (clone.code !== 0) throw new Error(`git clone of ${flags.repo} failed`);
  const cloneMs = deps.now() - cloneStart;
  await ensureGitIdentity(deps, cloneDir);
  prepareCloneDir(deps, cloneDir);
  return { cloneDir, cloneMs };
}

/** Run one issue in a fresh container. Always prints one JSON status line; returns the exit code. */
export async function runJob(opts: JobCommandOptions, deps: JobDeps): Promise<number> {
  const startedAt = deps.now();
  let flags: JobFlags;
  try {
    flags = validateJobFlags(opts, deps.env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log(message);
    const repo = opts.repo ?? '';
    const issue = Number(opts.issue);
    deps.stdout(
      JSON.stringify(
        jobStatusLine({
          flags: {
            repo,
            owner: '',
            name: '',
            issue: Number.isSafeInteger(issue) ? issue : 0,
            mode: 'pr',
            workdir: '',
            factoryDir: undefined,
          },
          sources: undefined,
          run: undefined,
          exitCode: SETUP_FAILED,
          error: message,
          startedAt,
          cloneMs: undefined,
          runMs: undefined,
          finishedAt: deps.now(),
        }),
      ),
    );
    return SETUP_FAILED;
  }

  let sources: JobConfigSources | undefined;
  let cloneMs: number | undefined;
  let runMs: number | undefined;
  let run: RunResultJson | undefined;
  let exitCode = SETUP_FAILED;
  let error: string | undefined;
  try {
    const boot = await bootstrap(deps, flags);
    cloneMs = boot.cloneMs;
    const containerDefaultsPath = join(flags.workdir, '.factory-job', 'container-defaults.yaml');
    sources = resolveJobConfigSources(
      { cloneDir: boot.cloneDir, factoryDir: flags.factoryDir, containerDefaultsPath, exists: deps.exists },
      deps.env,
    );
    if (sources.writeContainerDefaults) {
      deps.mkdir(join(flags.workdir, '.factory-job'));
      deps.writeFile(containerDefaultsPath, YAML.stringify(CONTAINER_JOB_DEFAULTS), 0o600);
    }
    deps.log(`factory job: config source: ${sources.configSource}; constitution source: ${sources.constitutionSource}`);
    const runStart = deps.now();
    const child = await deps.run(deps.cliEntry.node, [deps.cliEntry.script, ...jobChildArgs(flags)], {
      cwd: boot.cloneDir,
      env: { ...deps.env, ...sources.env },
      captureStdout: true,
    });
    runMs = deps.now() - runStart;
    run = parseRunResult(child.stdout);
    if (child.signal !== null) {
      exitCode = 1;
      error = `killed by ${child.signal}`;
    } else if (child.code === 0 && run === undefined) {
      exitCode = SETUP_FAILED;
      error = 'the run exited 0 without a valid result line';
    } else {
      exitCode = child.code ?? 1;
    }
  } catch (err) {
    exitCode = SETUP_FAILED;
    error = `factory job: ${err instanceof Error ? err.message : String(err)}`;
    deps.log(error);
  }
  deps.stdout(
    JSON.stringify(
      jobStatusLine({ flags, sources, run, exitCode, error, startedAt, cloneMs, runMs, finishedAt: deps.now() }),
    ),
  );
  return exitCode;
}

function realRun(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; captureStdout?: boolean },
) {
  return new Promise<JobRunResult>((resolveRun, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', opts.captureStdout === true ? 'pipe' : 'inherit', 'inherit'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolveRun({ code, signal, stdout }));
  });
}

/** `factory job` action: real process, filesystem and clock. Non-zero exits are silent (`CliExitError('', code)`). */
export async function cmdJob(opts: JobCommandOptions): Promise<void> {
  const code = await runJob(opts, {
    env: process.env,
    run: realRun,
    exists: existsSync,
    isEmptyDir: (p) => readdirSync(p).length === 0,
    mkdir: (p) => void mkdirSync(p, { recursive: true }),
    writeFile: (p, text, mode) => writeFileSync(p, text, { mode }),
    appendFile: (p, text) => appendFileSync(p, text),
    readFile: (p) => readFileSync(p, 'utf8'),
    now: () => Date.now(),
    stdout: (line) => void process.stdout.write(`${line}\n`),
    log: (line) => void process.stderr.write(`${line}\n`),
    cliEntry: { node: process.execPath, script: process.argv[1] ?? '' },
  });
  if (code !== 0) throw new CliExitError('', code);
}
