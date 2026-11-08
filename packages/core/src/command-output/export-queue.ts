// packages/core/src/command-output/export-queue.ts — bounded in-memory batching queue with retry, backoff and
// explicit sent/dropped/failed accounting; no OpenTelemetry imports (#3995)

export type SendOutcome = 'ok' | 'failed';

export interface ExportCounts {
  sent: number;
  dropped: number;
  failed: number;
  retries: number;
}

export interface ExportQueue<T> {
  enqueue(item: T): boolean;
  counts(): ExportCounts;
  close(budgetMs: number): Promise<ExportCounts>;
}

export interface ExportQueueOptions<T> {
  send: (batch: T[]) => Promise<SendOutcome>;
  maxQueued?: number;
  batchSize?: number;
  lingerMs?: number;
  retry?: { initialMs?: number; maxMs?: number; maxAttempts?: number };
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

export function createExportQueue<T>(opts: ExportQueueOptions<T>): ExportQueue<T> {
  const maxQueued = opts.maxQueued ?? 2048;
  const batchSize = opts.batchSize ?? 256;
  const lingerMs = opts.lingerMs ?? 200;
  const initialMs = opts.retry?.initialMs ?? 250;
  const maxMs = opts.retry?.maxMs ?? 4000;
  const maxAttempts = opts.retry?.maxAttempts ?? 3;
  const sleep = opts.sleep ?? defaultSleep;

  const queue: T[] = [];
  const totals: ExportCounts = { sent: 0, dropped: 0, failed: 0, retries: 0 };
  let inFlight = 0;
  let closed = false;
  let expired = false;
  let draining: Promise<void> | undefined;
  let linger: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;

  const trySend = async (batch: T[]): Promise<SendOutcome> => {
    try {
      return await opts.send(batch);
    } catch {
      return 'failed';
    }
  };

  // Sleeps between retries; resolves early when the close budget expires.
  const backoff = (ms: number): Promise<void> =>
    Promise.race([
      sleep(ms),
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
    ]);

  const sendBatch = async (batch: T[]): Promise<void> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (expired) return;
      if ((await trySend(batch)) === 'ok') {
        if (!expired) totals.sent += batch.length;
        return;
      }
      if (attempt === maxAttempts || expired) break;
      totals.retries++;
      await backoff(Math.min(initialMs * 2 ** (attempt - 1), maxMs));
    }
    if (!expired) totals.failed += batch.length;
  };

  const drain = async (): Promise<void> => {
    while (queue.length > 0 && !expired) {
      const batch = queue.splice(0, batchSize);
      inFlight = batch.length;
      await sendBatch(batch);
      inFlight = 0;
    }
  };

  const kick = (): void => {
    if (linger) clearTimeout(linger);
    linger = undefined;
    if (draining) return;
    draining = drain().finally(() => {
      draining = undefined;
      if (queue.length > 0 && !expired) schedule();
    });
  };

  const schedule = (): void => {
    if (closed || queue.length >= batchSize) {
      kick();
      return;
    }
    if (draining || linger) return;
    linger = setTimeout(kick, lingerMs);
    linger.unref();
  };

  return {
    enqueue(item) {
      if (closed || queue.length + inFlight >= maxQueued) {
        totals.dropped++;
        return false;
      }
      queue.push(item);
      schedule();
      return true;
    },
    counts: () => ({ ...totals }),
    async close(budgetMs) {
      closed = true;
      kick();
      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
        timer.unref();
      });
      await Promise.race([draining ?? Promise.resolve(), budget]);
      if (timer) clearTimeout(timer);
      expired = true;
      wake?.();
      totals.failed += queue.length + inFlight;
      queue.length = 0;
      inFlight = 0;
      return { ...totals };
    },
  };
}
