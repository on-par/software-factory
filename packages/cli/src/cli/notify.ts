// packages/cli/src/cli/notify.ts — opt-in --notify command fired on park and drain (#3512)
import { spawn } from 'node:child_process';

import type { ParkPayload } from '@on-par/factory-core';
import type { logEvent } from '@on-par/factory-core/internal';

export const NOTIFY_ENV = 'FACTORY_NOTIFY_CMD';
export const DRAIN_MESSAGE = 'queue drained: all lanes finished, nothing left';
const DEFAULT_TIMEOUT_MS = 30_000;

export type NotifySummary =
  | { kind: 'park'; ts: string; issue: number | string; lane: string; message: string; park: ParkPayload }
  | {
      kind: 'disk_low';
      ts: string;
      host: string;
      message: string;
      freeGb: number;
      thresholdGb: number;
      path: string;
    }
  | { kind: 'drain'; ts: string; message: string; parked: number };

export interface Notifier {
  /** Fire-and-forget: spawns the command with `summary` on stdin. Never throws. */
  notify(summary: NotifySummary): void;
  /** Resolves once every spawned notify process has exited or been killed. Never rejects. */
  settle(): Promise<void>;
  /** Park summaries sent so far (for the drain summary). */
  readonly parked: number;
}

export interface NotifierDeps {
  spawn?: typeof spawn;
  onError?: (message: string) => void;
  timeoutMs?: number;
  now?: () => Date;
}

export function resolveNotifyCommand(flag: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const fromFlag = flag?.trim();
  if (fromFlag) return fromFlag;
  const fromEnv = env[NOTIFY_ENV]?.trim();
  return fromEnv || undefined;
}

export function createNotifier(cmd: string | undefined, deps: NotifierDeps = {}): Notifier | undefined {
  if (cmd === undefined || cmd.trim() === '') return undefined;
  const spawnFn = deps.spawn ?? spawn;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const inFlight = new Set<Promise<void>>();
  let parked = 0;

  const run = (summary: NotifySummary): Promise<void> =>
    new Promise<void>((resolve) => {
      let reported = false;
      const report = (cause: string): void => {
        if (reported) return;
        reported = true;
        try {
          deps.onError?.(`notify command '${cmd}' failed: ${cause}`);
        } catch {
          // reporting must never affect the run
        }
      };
      try {
        const child = spawnFn(cmd, { shell: true, stdio: ['pipe', 'ignore', 'ignore'] });
        const timer = setTimeout(() => {
          report(`timed out after ${timeoutMs}ms`);
          child.kill('SIGKILL');
        }, timeoutMs);
        timer.unref();
        child.on('error', (err) => {
          clearTimeout(timer);
          report(err.message);
          resolve();
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (code !== 0) report(code === null ? `killed by ${signal}` : `exit ${code}`);
          resolve();
        });
        child.stdin?.on('error', (err) => report(`stdin: ${err.message}`));
        child.stdin?.end(`${JSON.stringify(summary)}\n`);
      } catch (err) {
        report(err instanceof Error ? err.message : String(err));
        resolve();
      }
    });

  return {
    notify(summary) {
      if (summary.kind === 'park') parked += 1;
      const p = run(summary).finally(() => inFlight.delete(p));
      inFlight.add(p);
    },
    settle: () => Promise.allSettled(inFlight).then(() => {}),
    get parked() {
      return parked;
    },
  };
}

/** Wraps an event emitter so each lane `parked` event with a park payload also fires a park summary. */
export function withParkNotify(emit: typeof logEvent, notifier: Notifier): typeof logEvent {
  return (...args: Parameters<typeof logEvent>): ReturnType<typeof logEvent> => {
    const result = emit(...args);
    const [, type, issue, msg, extra] = args;
    if (type === 'parked' && extra?.park) {
      try {
        notifier.notify({
          kind: 'park',
          ts: new Date().toISOString(),
          issue,
          lane: extra.lane ?? extra.park.lane,
          message: msg,
          park: extra.park,
        });
      } catch {
        // notify must never break the event log
      }
    }
    return result;
  };
}
