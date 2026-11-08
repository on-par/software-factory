// packages/cli/src/cli/shutdown.ts — first SIGINT/SIGTERM stops tracked agent process groups, flushes OTLP command
// output exports within a bounded budget and exits 130 (#1615, #3996)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { styleText } from 'node:util';
import { getFactoryPaths } from '@on-par/factory-core';
import {
  type CommandOutputFlushReport,
  flushCommandOutputExports,
  formatStopMarker,
  killTrackedProcessGroups,
} from '@on-par/factory-core/internal';

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
  writeStop?: (path: string, body: string) => void;
  flushExports?: (signal: NodeJS.Signals) => Promise<readonly CommandOutputFlushReport[]>;
  exit?: (code: number) => void;
  log?: (line: string) => void;
}

export interface ShutdownHandle {
  dispose(): void;
}

export const SHUTDOWN_EXIT_CODE = 130;
export const SHUTDOWN_GRACE_MS = 3000;
/** Must exceed the 2 s export flush budget plus the 500 ms exporter shutdown. */
export const SHUTDOWN_FLUSH_GUARD_MS = 3000;

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
  const flushExports = options.flushExports ?? ((s: NodeJS.Signals) => flushCommandOutputExports(s));
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
    let guardTimer: NodeJS.Timeout | undefined;
    try {
      const guard = new Promise<'timeout'>((resolve) => {
        guardTimer = setTimeout(() => resolve('timeout'), SHUTDOWN_FLUSH_GUARD_MS);
        guardTimer.unref();
      });
      const reports = await Promise.race([flushExports(signal), guard]);
      if (reports === 'timeout') {
        log(`factory: command output export flush timed out after ${SHUTDOWN_FLUSH_GUARD_MS} ms — records may be lost`);
      } else {
        for (const r of reports) {
          if (r.complete) continue;
          if (r.error !== undefined) {
            log(`factory: command output export failed for run ${r.runId}: ${r.error}`);
            continue;
          }
          log(`factory: command output export incomplete for run ${r.runId}: ${r.dropped} dropped, ${r.failed} failed`);
        }
      }
    } catch {
      // The flush never blocks exit.
    } finally {
      clearTimeout(guardTimer);
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
