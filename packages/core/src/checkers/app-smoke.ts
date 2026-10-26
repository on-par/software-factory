// src/checkers/app-smoke.ts — opt-in CHECK checker: boots the built app on the lane port and runs the repo's smoke command (#3253).

import { spawn } from 'node:child_process';

import { loadRepoConfig } from '../config/repo.js';
import type { QaConfig } from '../config/qa-section.js';
import { killProcessGroup } from '../environment/process-groups.js';
import type { CheckerOutput } from '../types/index.js';
import { checkerParentEnv } from '../environment/checker-env.js';
import { childProcessEnv } from '../utils/github-credentials.js';
import type { CommandResult } from '../utils/command-runner.js';
import { stripAnsi, writeCommandLog } from './command-log.js';
import type { CheckerContext } from './index.js';
import { runVerificationCommand, VERIFICATION_SCRUBBED_ENV_VARS } from './run-command.js';

export const APP_SMOKE_CHECKER = 'app_smoke';

const OUTPUT_CAP_BYTES = 64 * 1024;
const TAIL_CHARS = 2000;
const POLL_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 2000;
const KILL_GRACE_MS = 2000;
const DEFAULT_SMOKE_TIMEOUT_SECONDS = 300;

export interface StartedApp {
  pid?: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Combined stdout and stderr, kept to the last ~64 KB. */
  output: () => string;
}

export interface AppSmokeDeps {
  startApp: (
    argv: readonly string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; onPgid?: (pgid: number) => void },
  ) => StartedApp;
  probeReady: (url: string) => Promise<number | null>;
  killGroup: (pgid: number) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const defaultStartApp: AppSmokeDeps['startApp'] = (argv, { cwd, env, onPgid }) => {
  const child = spawn(argv[0] ?? '', argv.slice(1), {
    cwd,
    env,
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  const collect = (chunk: Buffer): void => {
    buffer = (buffer + chunk.toString()).slice(-OUTPUT_CAP_BYTES);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', (err) => {
      collect(Buffer.from(`${err.message}\n`));
      resolve({ code: -1, signal: null });
    });
  });
  if (child.pid !== undefined) onPgid?.(child.pid);
  return { pid: child.pid, exited, output: () => buffer };
};

const defaultProbeReady: AppSmokeDeps['probeReady'] = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' });
    return res.status;
  } catch {
    return null;
  }
};

const DEFAULT_DEPS: AppSmokeDeps = {
  startApp: defaultStartApp,
  probeReady: defaultProbeReady,
  killGroup: (pgid) => killProcessGroup(pgid, { graceMs: KILL_GRACE_MS }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

function exitedReason(exit: { code: number | null; signal: NodeJS.Signals | null }): string {
  return `start exited (code ${exit.code ?? exit.signal}) before ready`;
}

function smokeTail(r: CommandResult): string {
  const tail = stripAnsi(r.stderr.trim() !== '' ? r.stderr : r.stdout)
    .trim()
    .slice(-TAIL_CHARS);
  return tail || (r.timedOut ? 'timed out' : `exit code ${r.exitCode}`);
}

function skip(details: string): CheckerOutput {
  return { checker: APP_SMOKE_CHECKER, result: 'SKIP', details };
}

function fail(details: string): CheckerOutput {
  return { checker: APP_SMOKE_CHECKER, result: 'FAIL', details };
}

function loadQa(ctx: CheckerContext): QaConfig | null {
  return ctx.qa !== undefined ? ctx.qa : (loadRepoConfig(ctx.worktree)?.qa ?? null);
}

export async function appSmokeChecker(ctx: CheckerContext, deps: Partial<AppSmokeDeps> = {}): Promise<CheckerOutput> {
  let killError: string | undefined;
  const out = await runAppSmoke(ctx, deps, (msg) => {
    killError = msg;
  });
  if (killError === undefined) return out;
  return { ...out, details: `${out.details}\nstart process group not killed: ${killError}` };
}

async function runAppSmoke(
  ctx: CheckerContext,
  deps: Partial<AppSmokeDeps>,
  onKillError: (msg: string) => void,
): Promise<CheckerOutput> {
  const { startApp, probeReady, killGroup, sleep, now } = { ...DEFAULT_DEPS, ...deps };

  let qa: QaConfig | null;
  try {
    qa = loadQa(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`invalid .factory/config.json — ${msg.slice(0, 500)}`);
  }
  if (!qa?.start?.length || !qa.smoke?.length) return skip('no qa.start/qa.smoke in .factory/config.json');

  const port = Number(ctx.env?.PORT);
  if (!Number.isInteger(port) || port <= 0) {
    return skip('unavailable — no leased lane port (enable environment.ports)');
  }

  const startArgv = qa.start;
  const smokeArgv = qa.smoke;
  const readyPath = qa.readyPath ?? '/';
  const readyTimeoutSeconds = qa.readyTimeoutSeconds ?? 60;
  const env = {
    ...childProcessEnv(checkerParentEnv(process.env), ctx.env),
    ...Object.fromEntries(VERIFICATION_SCRUBBED_ENV_VARS.map((name) => [name, undefined])),
    HOST: '127.0.0.1',
  };
  const url = `http://127.0.0.1:${port}${readyPath}`;

  let startPgid: number | undefined;
  const app = startApp(startArgv, {
    cwd: ctx.worktree,
    env,
    onPgid: (pgid) => {
      startPgid = pgid;
      ctx.onPgid?.(pgid);
    },
  });
  const state: { exit?: { code: number | null; signal: NodeJS.Signals | null } } = {};
  void app.exited.then((e) => {
    state.exit = e;
  });

  const startResult = (): CommandResult => ({
    command: startArgv,
    stdout: app.output(),
    stderr: '',
    exitCode: state.exit?.code ?? -1,
    killed: state.exit?.signal != null,
    timedOut: false,
    ok: false,
  });
  const startFail = async (reason: string): Promise<CheckerOutput> => {
    const path = await writeCommandLog(ctx, 'app_smoke-start', startResult());
    const tail = stripAnsi(app.output()).trim().slice(-TAIL_CHARS);
    return fail(`${reason}${tail ? `: ${tail}` : ''}${path ? `\nfull output: ${path}` : ''}`);
  };

  try {
    const deadline = now() + readyTimeoutSeconds * 1000;
    let ready = false;
    while (now() < deadline) {
      if (state.exit) return await startFail(exitedReason(state.exit));
      const status = await probeReady(url);
      if (status !== null && status < 500) {
        ready = true;
        break;
      }
      if (state.exit) return await startFail(exitedReason(state.exit));
      await sleep(POLL_INTERVAL_MS);
    }
    if (!ready) return await startFail(`not ready after ${readyTimeoutSeconds}s on ${url}`);

    const run = ctx.runCommand ?? runVerificationCommand;
    const r = await run(smokeArgv, {
      cwd: ctx.worktree,
      env: ctx.env,
      onPgid: ctx.onPgid,
      timeoutMs: (ctx.testsTimeoutSeconds ?? DEFAULT_SMOKE_TIMEOUT_SECONDS) * 1000,
    });
    if (!r.ok) {
      const startPath = await writeCommandLog(ctx, 'app_smoke-start', startResult());
      const smokePath = await writeCommandLog(ctx, 'app_smoke-smoke', r);
      const logs = [startPath, smokePath].filter((p): p is string => p !== null);
      return fail(
        `smoke exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}: ${smokeTail(r)}` +
          (logs.length ? `\nfull output: ${logs.join(', ')}` : ''),
      );
    }
    return { checker: APP_SMOKE_CHECKER, result: 'PASS', details: `app ready on ${url}; smoke passed` };
  } finally {
    if (startPgid !== undefined)
      await killGroup(startPgid).catch((err: unknown) => onKillError(err instanceof Error ? err.message : String(err)));
  }
}
