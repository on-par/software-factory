// packages/core/src/utils/command-runner.ts — shared argv-based command runner (no shell)
import { spawn } from 'node:child_process';

import { execa } from 'execa';

import { basename } from 'node:path';

import { killProcessGroup } from '../environment/process-groups.js';
import { childProcessEnv, redactGitHubCredentials } from './github-credentials.js';
import { spawnSupervisedCommand } from './supervised-exec.js';

export interface RunCommandOptions {
  cwd?: string;
  /** Milliseconds. Always ms — call sites must not pass seconds. */
  timeoutMs?: number;
  maxBuffer?: number;
  /** Undefined values explicitly remove inherited variables. */
  env?: NodeJS.ProcessEnv;
  /** When set, the child is spawned detached (its own process group) and
   *  its pid is reported here so a lane can track and later kill the
   *  whole group. */
  onPgid?: (pgid: number) => void;
  /** Grace period before SIGKILL when sweeping the group after termination. */
  killGraceMs?: number;
  /** Defaults to `process.platform`. Used only on the `onPgid` path. */
  platform?: NodeJS.Platform;
  /** Test seam; defaults to `killProcessGroup`. */
  killGroup?: typeof killProcessGroup;
  /** Pass the parent's GitHub credentials (GITHUB_TOKEN, GH_TOKEN, …) to the
   *  child. Defaults to true only when argv[0] is `gh` or `git` (the factory's
   *  own GitHub calls); every other command — checkers running agent-written
   *  code, repo scripts — gets an environment without them. */
  githubAuth?: boolean;
}

export interface CommandResult {
  /** The argv that ran, for diagnostics. */
  command: readonly string[];
  stdout: string;
  stderr: string;
  /** -1 when the process produced no exit code (spawn failure or killed). */
  exitCode: number;
  /** True when the process was terminated by a signal (incl. timeout kill). */
  killed: boolean;
  /** True when terminated because timeoutMs elapsed. */
  timedOut: boolean;
  /** exitCode === 0 && !killed && !timedOut */
  ok: boolean;
}

const DEFAULT_MAX_BUFFER = 1000 * 1000 * 100;

/** argv-based (no shell) detached run for the `onPgid` path. Resolves on the
 *  child's own `exit`, not on its piped stdio closing: a backgrounded
 *  grandchild (e.g. a dev server the checker command starts) would
 *  otherwise keep the inherited pipe open past the direct child's own exit,
 *  hanging execa's stream-aware result past any timeout. After settling, a
 *  timeout or any signal-based termination triggers a `killProcessGroup`
 *  sweep so such grandchildren don't outlive the check. On win32 there are no
 *  process groups and `child.kill()` ends only the root (after which taskkill
 *  can't find the tree), so timeout/maxBuffer kills start the `taskkill /T`
 *  tree kill while the root is alive and the sweep reuses it. */
async function runCommandDetached(
  argv: readonly string[],
  options: RunCommandOptions,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const platform = options.platform ?? process.platform;
  const killGroup = options.killGroup ?? killProcessGroup;
  const win32 = platform === 'win32';
  const ownershipFile = env.FACTORY_DAEMON_GROUPS_FILE;
  const child = ownershipFile
    ? spawnSupervisedCommand(argv, { cwd: options.cwd, env, ownershipFile })
    : spawn(argv[0], argv.slice(1), {
        cwd: options.cwd,
        env,
        detached: !win32,
        shell: false,
      });

  const pid = child.pid;
  if (pid !== undefined) options.onPgid?.(pid);

  let stdoutLen = 0;
  let stderrLen = 0;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let maxBufferExceeded = false;
  let timedOut = false;
  let settled = false;

  let treeKill: Promise<unknown> | undefined;
  const terminate = () => {
    if (win32 && pid !== undefined) {
      treeKill ??= killGroup(pid, { graceMs: options.killGraceMs, platform }).then(
        (o) => {
          if (!o.terminated) child.kill();
        },
        () => child.kill(),
      );
      return;
    }
    child.kill();
  };

  const timer =
    options.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, options.timeoutMs)
      : undefined;

  const { exitCode, signal } = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdoutLen += chunk.length;
        if (stdoutLen > maxBuffer) {
          maxBufferExceeded = true;
          terminate();
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (settled) return;
        stderrLen += chunk.length;
        if (stderrLen > maxBuffer) {
          maxBufferExceeded = true;
          terminate();
          return;
        }
        stderrChunks.push(chunk);
      });
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        resolve({ exitCode: code, signal });
      };
      child.on('error', () => finish(-1, null));
      child.on('exit', finish);
      if (ownershipFile)
        child.on('message', (message) => {
          const result = (message as { factoryExit?: { code: number | null; signal: NodeJS.Signals | null } })
            .factoryExit;
          if (result) finish(result.code, result.signal);
        });
    },
  );

  if (timer) clearTimeout(timer);

  const isTerminated = timedOut || maxBufferExceeded || signal !== null;
  if (isTerminated && pid !== undefined) {
    if (win32 && treeKill) await treeKill;
    else await killGroup(pid, { graceMs: options.killGraceMs, platform });
  }

  return {
    command: argv,
    stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
    stderr: Buffer.concat(stderrChunks).toString('utf-8'),
    exitCode: typeof exitCode === 'number' ? exitCode : -1,
    killed: isTerminated,
    timedOut,
    ok: exitCode === 0 && !isTerminated,
  };
}

export async function runCommand(argv: readonly string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  if (argv.length === 0 || argv[0].trim() === '') {
    throw new TypeError('runCommand: argv must be non-empty and argv[0] must not be blank');
  }

  const githubAuth = options.githubAuth ?? isGitHubClient(argv[0]);
  const env = childProcessEnv(process.env, options.env, { githubAuth });

  const result = options.onPgid
    ? await runCommandDetached(argv, options, env)
    : await runCommandAttached(argv, options, env);
  if (result.ok) return result;
  return {
    ...result,
    stdout: redactGitHubCredentials(result.stdout),
    stderr: redactGitHubCredentials(result.stderr),
  };
}

/** `gh` and `git` are the only binaries that get GitHub credentials by default. */
function isGitHubClient(bin: string): boolean {
  const name = basename(bin.trim());
  return name === 'gh' || name === 'git';
}

async function runCommandAttached(
  argv: readonly string[],
  options: RunCommandOptions,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const r = await execa(argv[0], argv.slice(1), {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    env,
    extendEnv: false,
    reject: false,
    all: false,
  });

  const exitCode = typeof r.exitCode === 'number' ? r.exitCode : -1;
  const killed = r.isTerminated === true;
  const timedOut = r.timedOut === true;
  const stdout = typeof r.stdout === 'string' ? r.stdout : '';
  const stderr =
    r.failed && typeof r.exitCode !== 'number' ? (r.shortMessage ?? '') : typeof r.stderr === 'string' ? r.stderr : '';

  return {
    command: argv,
    stdout,
    stderr,
    exitCode,
    killed,
    timedOut,
    ok: exitCode === 0 && !killed && !timedOut,
  };
}

/** First non-empty of stderr, stdout, or an exit-code note — for FAIL details. */
export function describeCommandFailure(r: CommandResult): string {
  return r.stderr || r.stdout || (r.timedOut ? `timed out` : `exit code ${r.exitCode}`);
}
