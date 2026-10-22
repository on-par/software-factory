import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { DEPENDENCY_INSTALL_TIMEOUT_MS, dependencyInstallCommand } from '../checkers/baseline.js';
import type { EventKind } from '../events/kinds.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { runCommand as runCommandDefault } from '../utils/command-runner.js';

export interface LaneInstallOptions {
  worktree: string;
  env: NodeJS.ProcessEnv;
  log: (type: EventKind, msg: string) => void;
  sandbox?: SandboxPolicy;
  /** The workspace is the caller's own checkout; it must never be touched. */
  localOnly?: boolean;
  onPgid?: (pgid: number) => void;
  runCommand?: typeof runCommandDefault;
  now?: () => number;
}

export type LaneInstallResult =
  | { status: 'skipped'; reason: string }
  | { status: 'installed'; command: readonly string[]; durationMs: number }
  | { status: 'failed'; command: readonly string[]; durationMs: number; output: string };

const OUTPUT_TAIL_CHARS = 300;

/** Runs the lockfile's frozen JS install once in a fresh lane worktree before BUILD (#3370).
 *  Never throws: a failed install is logged and BUILD goes on. */
export async function installLaneDependencies(opts: LaneInstallOptions): Promise<LaneInstallResult> {
  const { worktree, log } = opts;
  const skip = (reason: string): LaneInstallResult => {
    log('lane_install', `skipped: ${reason}`);
    return { status: 'skipped', reason };
  };
  if (opts.localOnly) return skip('local-only workspace');
  if (opts.sandbox?.runtime === 'docker-sandbox') return skip('micro-VM sandbox');
  const argv = dependencyInstallCommand(worktree);
  if (argv === null) return skip('no package.json');
  if (existsSync(join(worktree, 'node_modules'))) return skip('node_modules already present');

  const run = opts.runCommand ?? runCommandDefault;
  const now = opts.now ?? Date.now;
  const started = now();
  let output: string;
  try {
    const r = await run(argv, {
      cwd: worktree,
      env: opts.env,
      timeoutMs: DEPENDENCY_INSTALL_TIMEOUT_MS,
      onPgid: opts.onPgid,
    });
    if (r.ok) {
      const durationMs = now() - started;
      log('lane_install', `${argv.join(' ')} (${durationMs}ms)`);
      return { status: 'installed', command: argv, durationMs };
    }
    const tail = (r.stderr || r.stdout).trim().slice(-OUTPUT_TAIL_CHARS);
    output = r.timedOut ? `timed out after ${DEPENDENCY_INSTALL_TIMEOUT_MS / 1000}s: ${tail}` : tail;
  } catch (err) {
    output = (err instanceof Error ? err.message : String(err)).slice(-OUTPUT_TAIL_CHARS);
  }
  const durationMs = now() - started;
  log('lane_install_failed', `${argv.join(' ')} failed — continuing to BUILD: ${output}`);
  return { status: 'failed', command: argv, durationMs, output };
}
