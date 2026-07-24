// src/environment/process-groups.ts — Kill a detached child's whole process group
// (SIGTERM -> grace -> SIGKILL), and track pgids for a lane so terminal-state
// cleanup can sweep every group it ever spawned.

export interface KillProcessGroupOptions {
  /** Milliseconds to wait after SIGTERM before escalating to SIGKILL. Default 5000. */
  graceMs?: number;
  killFn?: (pid: number, signal: NodeJS.Signals | 0) => void;
  isAliveFn?: (pgid: number) => boolean;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface KillOutcome {
  pgid: number;
  /** True when the group was confirmed dead after signaling. */
  terminated: boolean;
  /** True when SIGKILL was needed (SIGTERM alone did not clear the group within grace). */
  forced: boolean;
}

const POLL_INTERVAL_MS = 100;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Signal-0 probe against the process *group* leader: `process.kill(-pgid, 0)`.
 *  ESRCH -> false (dead); EPERM -> true (alive, just not ours); mirrors
 *  `defaultIsPidAlive` in environment/index.ts. */
export function defaultIsProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/** SIGTERM the whole process group led by `pgid`, wait up to `graceMs` for it
 *  to die, then SIGKILL if it hasn't. Never throws — ESRCH/EPERM on either
 *  signal are swallowed since the group may already be gone or unowned. */
export async function killProcessGroup(pgid: number, opts: KillProcessGroupOptions = {}): Promise<KillOutcome> {
  const graceMs = opts.graceMs ?? 5000;
  const killFn = opts.killFn ?? ((pid, signal) => process.kill(pid, signal));
  const isAliveFn = opts.isAliveFn ?? defaultIsProcessGroupAlive;
  const sleepFn = opts.sleepFn ?? defaultSleep;

  type SignalOutcome = 'sent' | 'dead' | 'not-ours';

  const sendSignal = (signal: NodeJS.Signals): SignalOutcome => {
    try {
      killFn(-pgid, signal);
      return 'sent';
    } catch (err: any) {
      if (err?.code === 'ESRCH') return 'dead';
      if (err?.code === 'EPERM') return 'not-ours';
      return 'sent';
    }
  };

  const termResult = sendSignal('SIGTERM');
  if (termResult === 'dead') {
    return { pgid, terminated: true, forced: false };
  }
  if (termResult === 'not-ours') {
    return { pgid, terminated: false, forced: false };
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAliveFn(pgid)) {
      return { pgid, terminated: true, forced: false };
    }
    await sleepFn(Math.min(POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
  }

  if (!isAliveFn(pgid)) {
    return { pgid, terminated: true, forced: false };
  }

  sendSignal('SIGKILL');
  const terminated = !isAliveFn(pgid);
  return { pgid, terminated, forced: true };
}

/** Tracks the process-group pgids a lane has spawned (harness/checker
 *  children run `detached: true`, so each leads its own group) and kills
 *  them all on terminal state. */
export class ProcessGroupTracker {
  private readonly tracked = new Set<number>();

  track(pgid: number): void {
    this.tracked.add(pgid);
  }

  untrack(pgid: number): void {
    this.tracked.delete(pgid);
  }

  get pgids(): number[] {
    return [...this.tracked];
  }

  /** Kills every tracked group still alive, clears the tracker, and returns
   *  outcomes for the ones that were actually killed. Idempotent: a second
   *  call (nothing left tracked) resolves to `[]`. */
  async killAll(opts: KillProcessGroupOptions = {}): Promise<KillOutcome[]> {
    const isAliveFn = opts.isAliveFn ?? defaultIsProcessGroupAlive;
    const pgids = this.pgids;
    this.tracked.clear();

    const alive = pgids.filter((pgid) => isAliveFn(pgid));
    return Promise.all(alive.map((pgid) => killProcessGroup(pgid, opts)));
  }
}
