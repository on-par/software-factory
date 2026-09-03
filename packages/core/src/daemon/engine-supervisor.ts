// src/daemon/engine-supervisor.ts — Per-engine liveness supervision for factoryd
// (#1178, epic #764). One supervisor owns one in-process engine for one attached
// repo: staleness is measured from the engine event stream (events.ndjson
// activity, ADR-0002), a stale engine is stopped and relaunched in-process, and
// every restart publishes exactly one 'engine-restarted' event. Restart is a
// pure lifecycle action: unlike the legacy relaunch-if-dead.sh cron script, the
// restart path never snapshots or backs up queue state — the logEvent append is
// this module's ONLY filesystem write (see the ADR shipped with #1178).

import { stat } from 'node:fs/promises';

import { logEvent } from '../utils/index.js';
import { createDaemonLaneContext, type DaemonLaneContext } from './lane-context.js';
import { dispatchableRepos, type RepoRegistry, type RepoRegistryListing } from './registry.js';

/** A running in-process engine as the supervisor sees it. `done` settles when the
 *  engine loop exits (resolve or reject — the supervisor swallows rejections);
 *  `stop()` asks the engine to shut down and resolves when it has. */
export interface EngineHandle {
  done: Promise<void>;
  stop(): Promise<void>;
}

/** Injected engine-launch port. Core never imports the CLI's engine loop
 *  (contracts <- core <- cli) — the daemon caller wires the real engine, tests
 *  wire fakes. Mirrors DaemonOrchestrator in run-repo.ts. */
export type EngineRunner = (context: DaemonLaneContext) => EngineHandle;

export const DEFAULT_STALE_THRESHOLD_MS = 15 * 60_000;
export const DEFAULT_SUPERVISOR_POLL_MS = 60_000;

export interface EngineSupervisorOptions {
  /** No event-stream activity for longer than this => stale. */
  staleThresholdMs?: number;
  /** Poll cadence for the background interval. */
  pollMs?: number;
  /** Injectable clock (ms epoch). Default Date.now. */
  now?: () => number;
  /** Last engine activity in ms epoch, or null when no events exist yet.
   *  Default: stat(context.paths.events).mtimeMs; missing file => null. */
  lastEventAt?: (context: DaemonLaneContext) => Promise<number | null>;
  /** Warn-line sink for non-fatal supervisor trouble (a failing stop()).
   *  Default console.error; injectable for tests. */
  log?: (line: string) => void;
}

export interface EngineSupervisor {
  /** The context the engine runs with (external stateRoot resolved). */
  context: DaemonLaneContext;
  /** Launches the engine and arms the poll interval. Idempotent. */
  start(): void;
  /** One deterministic staleness check (also what the interval calls).
   *  'idle' before start() / after stop(); 'fresh' when within threshold;
   *  'restarted' when a stale engine was stopped and relaunched. */
  checkNow(): Promise<'idle' | 'fresh' | 'restarted'>;
  /** Restarts performed so far (observability for the daemon status surface). */
  restarts(): number;
  /** Halts polling and stops the running engine. No restart after this. */
  stop(): Promise<void>;
}

async function defaultLastEventAt(context: DaemonLaneContext): Promise<number | null> {
  try {
    return (await stat(context.paths.events)).mtimeMs;
  } catch {
    return null;
  }
}

/** Supervises one in-process engine for one registry entry. Callers own
 *  start()/stop(); checkNow() is the deterministic seam the poll interval
 *  drives (mirrors project-board-poller). */
export function superviseEngine(
  entry: RepoRegistryListing,
  runEngine: EngineRunner,
  opts: EngineSupervisorOptions = {},
): EngineSupervisor {
  const staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const pollMs = opts.pollMs ?? DEFAULT_SUPERVISOR_POLL_MS;
  const now = opts.now ?? Date.now;
  const lastEventAt = opts.lastEventAt ?? defaultLastEventAt;
  const log = opts.log ?? ((line: string) => console.error(line));

  const context = createDaemonLaneContext(entry);
  let handle: EngineHandle | null = null;
  let startedAt = 0;
  let restartCount = 0;
  let timer: NodeJS.Timeout | null = null;
  let checking = false;
  let stopped = false;

  const launch = (): void => {
    handle = runEngine(context);
    startedAt = now();
    // A crashing engine must never raise an unhandled rejection: the staleness
    // poll is what notices a dead engine — events stop, the threshold passes,
    // the restart happens (the cron script's liveness idea, moved in-process).
    handle.done.catch(() => {});
  };

  const checkNow = async (): Promise<'idle' | 'fresh' | 'restarted'> => {
    if (handle === null || stopped || checking) return 'idle';
    checking = true;
    try {
      const last = await lastEventAt(context);
      // stop() may have run while we awaited — it already stopped the engine,
      // and nothing may relaunch after it (the no-restart-after-stop contract).
      if (stopped) return 'idle';
      // The start-time floor keeps a just-(re)started engine with no events yet
      // from being instantly stale.
      const effective = Math.max(last ?? 0, startedAt);
      const age = now() - effective;
      if (age <= staleThresholdMs) return 'fresh';

      const stale = handle;
      try {
        await stale.stop();
      } catch (err) {
        log(`engine-supervisor[${entry.slug}]: stop of stale engine failed: ${String(err)}`);
      }
      if (stopped) return 'idle';
      launch();
      restartCount += 1;
      logEvent(
        context.paths.events,
        'engine-restarted',
        entry.slug,
        `engine stale for ${age}ms (threshold ${staleThresholdMs}ms) — restarted in-process`,
        { lane: entry.slug, actor: 'factoryd' },
      );
      return 'restarted';
    } finally {
      checking = false;
    }
  };

  return {
    context,
    start(): void {
      if (stopped || handle !== null) return;
      launch();
      timer = setInterval(() => {
        void checkNow().catch((err) => {
          log(`engine-supervisor[${entry.slug}]: staleness check failed: ${String(err)}`);
        });
      }, pollMs);
      timer.unref?.();
    },
    checkNow,
    restarts(): number {
      return restartCount;
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      try {
        await handle?.stop();
      } catch (err) {
        log(`engine-supervisor[${entry.slug}]: stop failed: ${String(err)}`);
      }
    },
  };
}

/** One supervisor per dispatchable (state === 'active') registry entry, keyed by
 *  slug. Paused/draining/detached entries are never supervised. Callers own
 *  start()/stop() on each. */
export function superviseActiveRepos(
  registry: RepoRegistry,
  runEngine: EngineRunner,
  opts: EngineSupervisorOptions = {},
): Map<string, EngineSupervisor> {
  return new Map(dispatchableRepos(registry).map((entry) => [entry.slug, superviseEngine(entry, runEngine, opts)]));
}
