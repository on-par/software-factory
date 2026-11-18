export type RunStopReason = 'deadline' | 'sigterm';

export interface RunStop {
  reason(): RunStopReason | undefined;
  dispose(): void;
}

const active = new Set<{ signal: () => void }>();

export function createRunStop(opts: { deadlineAtMs?: number; marginMs: number; now: () => number }): RunStop {
  let signalled = false;
  const entry = { signal: () => (signalled = true) };
  active.add(entry);
  return {
    reason() {
      if (signalled) return 'sigterm';
      if (opts.deadlineAtMs !== undefined && opts.now() >= opts.deadlineAtMs - opts.marginMs) return 'deadline';
      return undefined;
    },
    dispose() {
      active.delete(entry);
    },
  };
}

export function requestRunStop(): number {
  for (const entry of active) entry.signal();
  return active.size;
}
