import { useEffect, useState } from 'react';

/** Ticking wall clock for elapsed/staleness rendering: without it a lane that simply stops
 *  emitting frames would never re-render, so it could never be shown as stale. */
export function useNow(intervalMs = 1_000, clock: () => number = Date.now): number {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const id = setInterval(() => setNow(clock()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, clock]);
  return now;
}
