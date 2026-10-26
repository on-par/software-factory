import { type QueueSnapshot, redactSecretPatterns } from '@on-par/factory-core';
import { useEffect, useState } from 'react';

import type { QueueReader } from './App.js';

/** Polls the queue reader. `loaded` flips once the first read succeeds, so callers can tell an
 *  empty queue from one that has not been read yet (#1365). */
export function useQueueSnapshot(
  queueReader: QueueReader | undefined,
  defaultPollMs: number,
): { snapshot: QueueSnapshot; loaded: boolean } {
  const [snapshot, setSnapshot] = useState<QueueSnapshot>({ entries: [] });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!queueReader) return;
    let cancelled = false;
    let inFlight = false;
    const read = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await queueReader.read();
        if (!cancelled) {
          setSnapshot(next);
          setLoaded(true);
        }
      } catch (err) {
        // GitHub-controlled text: redact anything token-shaped before it reaches the pane.
        const message = redactSecretPatterns(err instanceof Error ? err.message : String(err));
        if (!cancelled) setSnapshot((prev) => ({ ...prev, error: `queue lookup failed — ${message}` }));
      } finally {
        inFlight = false;
      }
    };
    void read();
    const interval = setInterval(() => void read(), queueReader.pollMs ?? defaultPollMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [queueReader, defaultPollMs]);

  return { snapshot, loaded };
}
