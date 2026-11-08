// packages/cli/src/cli/shutdown.ts — first SIGINT/SIGTERM stops tracked agent process groups, flushes exported command output and exits 130 (#1615)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { styleText } from 'node:util';
import { getFactoryPaths } from '@on-par/factory-core';
import { closeCommandOutputSession, formatStopMarker, killTrackedProcessGroups } from '@on-par/factory-core/internal';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';
const SHUTDOWN_SIGNALS: ShutdownSignal[] = ['SIGINT', 'SIGTERM'];

export interface ShutdownSignals {
  on(signal: ShutdownSignal, listener: (signal: NodeJS.Signals) => void): unknown;
  removeListener(signal: ShutdownSignal, listener: (signal: NodeJS.Signals) => void): unknown;
}

export interface ShutdownOptions {
  /** Resolves the STOP file path; a throw/reject is swallowed. */
  stopFile: () => string | Promise<string>;
  graceMs?: number;
  signals?: ShutdownSignals;
  killTracked?: (opts: { graceMs: number }) => Promise<unknown>;
  /** Flushes exported command output within the budget, after the sweep; a no-op when export is off. */
  flushOutput?: (budgetMs: number) => Promise<unknown>;
  writeStop?: (path: string, body: string) => void;
  exit?: (code: number) => void;
  log?: (line: string) => void;
}

export interface ShutdownHandle {
  dispose(): void;
}

export const SHUTDOWN_EXIT_CODE = 130;
export const SHUTDOWN_GRACE_MS = 3000;
/** Budget for flushing exported command output after the sweep, so a 10 s container stop still fits. */
export const SIGNAL_FLUSH_BUDGET_MS = 2500;

function defaultWriteStop(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, body, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

export function installShutdown(controller: AbortController, options: ShutdownOptions): ShutdownHandle {
  const signals = options.signals ?? process;
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
  const killTracked = options.killTracked ?? ((o: { graceMs: number }) => killTrackedProcessGroups(o));
  const flushOutput = options.flushOutput ?? ((budgetMs: number) => closeCommandOutputSession('signal', budgetMs));
  const writeStop = options.writeStop ?? defaultWriteStop;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((line: string) => console.error(styleText('dim', line)));
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    log(`factory: ${signal} received — stopping agents (send again to exit now)`);
    controller.abort();
    process.exitCode = SHUTDOWN_EXIT_CODE;
    try {
      const path = await options.stopFile();
      writeStop(path, formatStopMarker('manual', new Date(), `factory received ${signal}`));
    } catch {
      // STOP is best-effort; the process-group sweep below still runs.
    }
    try {
      await killTracked({ graceMs });
    } catch {
      // Exit regardless of sweep failures.
    }
    try {
      await flushOutput(SIGNAL_FLUSH_BUDGET_MS);
    } catch {
      // Exit regardless of flush failures; an unflushed session simply has no end record.
    }
    exit(SHUTDOWN_EXIT_CODE);
  };

  const listener = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      log(`factory: second ${signal} — exiting now`);
      exit(SHUTDOWN_EXIT_CODE);
      return;
    }
    shuttingDown = true;
    void shutdown(signal);
  };

  for (const s of SHUTDOWN_SIGNALS) signals.on(s, listener);
  return {
    dispose() {
      for (const s of SHUTDOWN_SIGNALS) signals.removeListener(s, listener);
    },
  };
}

async function defaultStopFile(): Promise<string> {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  return getFactoryPaths(root).stop;
}

export function withShutdown<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  options: Partial<ShutdownOptions> = {},
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const controller = new AbortController();
    const handle = installShutdown(controller, { stopFile: defaultStopFile, ...options });
    try {
      return await fn(...args);
    } finally {
      handle.dispose();
    }
  };
}
