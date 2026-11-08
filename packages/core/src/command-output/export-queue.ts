// src/command-output/export-queue.ts — bounded, counted delivery queue in front of the official OTLP log exporter.
// One batch is in flight at a time, so records arrive in order. A record counts as delivered only when the
// exporter's result callback reports success; transient failures retry with bounded backoff inside a bounded
// window, permanent ones are counted. Output past the bounds is dropped and counted; markers have reserved room.

import { type ExportResult, ExportResultCode } from '@opentelemetry/core';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';

/** Per-command delivery counts. `queued` holds records not yet settled (waiting or in flight). */
export interface DeliveryAccount {
  queued: number;
  acked: number;
  failed: number;
  dropped: number;
  markersDropped: number;
}

export function newAccount(): DeliveryAccount {
  return { queued: 0, acked: 0, failed: 0, dropped: 0, markersDropped: 0 };
}

export interface QueueEntry {
  /** `output` uses the unreserved room; `marker` (command start/end) may use the reserve; `session` is always kept. */
  readonly kind: 'output' | 'marker' | 'session';
  /** Approximate encoded size, counted against the byte bounds. */
  readonly bytes: number;
  readonly account?: DeliveryAccount;
  /** Starts a new batch, so it is built only after every earlier entry has settled. */
  readonly barrier?: boolean;
  /** Called once, when the entry joins a batch. */
  build(): ReadableLogRecord;
}

/** The part of the official `LogRecordExporter` the queue uses. */
export interface RecordExporter {
  export(records: ReadableLogRecord[], done: (result: ExportResult) => void): void;
}

export interface QueueLimits {
  maxRecords: number;
  maxBytes: number;
  reservedRecords: number;
  reservedBytes: number;
  batchRecords: number;
  batchBytes: number;
  /** How long a partial batch waits for more records before it is sent. */
  lingerMs: number;
}

export interface RetryPolicy {
  initialMs: number;
  maxMs: number;
  /** A batch still failing transiently this long after its first failure is counted failed. */
  windowMs: number;
}

const DEFAULT_LIMITS: QueueLimits = {
  maxRecords: 8_192,
  maxBytes: 8 * 1024 * 1024,
  reservedRecords: 512,
  reservedBytes: 512 * 1024,
  batchRecords: 512,
  batchBytes: 256 * 1024,
  lingerMs: 100,
};
const DEFAULT_RETRY: RetryPolicy = { initialMs: 250, maxMs: 4_000, windowMs: 30_000 };

export interface QueueTotals {
  acked: number;
  failed: number;
  dropped: number;
  markersDropped: number;
  retries: number;
  /** Records admitted but not settled. */
  queued: number;
}

export interface ExportQueue {
  /** Admits an entry or drops and counts it; never blocks. */
  enqueue(entry: QueueEntry): boolean;
  /** Sends everything queued; true once nothing is left, false when `budgetMs` ran out first. */
  flush(budgetMs: number): Promise<boolean>;
  /** Stops sending; later results and timers are ignored. Unsettled records stay counted in `queued`. */
  stop(): void;
  readonly totals: Readonly<QueueTotals>;
}

interface Batch {
  entries: QueueEntry[];
  records: ReadableLogRecord[];
  firstFailureAt?: number;
  failures: number;
}

/** The official exporter reports an HTTP rejection with a numeric status `code`; anything else (a network error,
 *  a timeout, an exhausted retryable status) is transient. */
function isPermanent(error: unknown): boolean {
  return typeof (error as { code?: unknown } | undefined)?.code === 'number';
}

export function createExportQueue(opts: {
  exporter: RecordExporter;
  /** The exporter's own per-export timeout; no attempt starts unless it can finish inside the flush budget. */
  exportTimeoutMs: number;
  limits?: Partial<QueueLimits>;
  retry?: Partial<RetryPolicy>;
}): ExportQueue {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const retry = { ...DEFAULT_RETRY, ...opts.retry };
  const totals: QueueTotals = { acked: 0, failed: 0, dropped: 0, markersDropped: 0, retries: 0, queued: 0 };
  let pending: QueueEntry[] = [];
  let head = 0;
  let bytes = 0;
  let pendingBytes = 0;
  let inFlight: Batch | undefined;
  let waitingRetry = false;
  let timer: NodeJS.Timeout | undefined;
  let deadline: number | undefined;
  let stopped = false;
  const waiters = new Set<() => void>();

  const arm = (ms: number, fn: () => void) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
    timer.unref();
  };

  const notifyIfDrained = () => {
    if (totals.queued !== 0) return;
    for (const w of waiters) w();
  };

  const canAttempt = () => !stopped && (deadline === undefined || deadline - Date.now() >= opts.exportTimeoutMs);

  const settle = (batch: Batch, outcome: 'acked' | 'failed') => {
    for (const e of batch.entries) {
      if (e.account) {
        e.account.queued--;
        e.account[outcome]++;
      }
      totals[outcome]++;
      totals.queued--;
      bytes -= e.bytes;
    }
    inFlight = undefined;
    notifyIfDrained();
    schedule();
  };

  const attempt = (batch: Batch) => {
    let answered = false;
    const done = (result: ExportResult) => {
      if (answered || stopped || batch !== inFlight) return;
      answered = true;
      if (result.code === ExportResultCode.SUCCESS) return settle(batch, 'acked');
      const now = Date.now();
      batch.firstFailureAt ??= now;
      batch.failures++;
      const delay = Math.min(retry.maxMs, retry.initialMs * 2 ** (batch.failures - 1));
      if (isPermanent(result.error) || now - batch.firstFailureAt + delay > retry.windowMs)
        return settle(batch, 'failed');
      totals.retries++;
      waitingRetry = true;
      arm(delay, () => {
        waitingRetry = false;
        if (canAttempt()) attempt(batch);
      });
    };
    try {
      opts.exporter.export(batch.records, done);
    } catch (error) {
      done({ code: ExportResultCode.FAILED, error: error as Error });
    }
  };

  const sendNext = () => {
    if (inFlight || !canAttempt()) return;
    const entries: QueueEntry[] = [];
    let size = 0;
    while (head < pending.length) {
      const e = pending[head];
      if (
        entries.length > 0 &&
        (e.barrier || entries.length >= limits.batchRecords || size + e.bytes > limits.batchBytes)
      )
        break;
      entries.push(e);
      size += e.bytes;
      head++;
    }
    if (entries.length === 0) return;
    pendingBytes -= size;
    if (head > 1024 && head * 2 > pending.length) {
      pending = pending.slice(head);
      head = 0;
    }
    inFlight = { entries, records: entries.map((e) => e.build()), failures: 0 };
    attempt(inFlight);
  };

  function schedule(): void {
    if (inFlight || waitingRetry || stopped || head >= pending.length) return;
    const full = pending.length - head >= limits.batchRecords || pendingBytes >= limits.batchBytes;
    if (deadline !== undefined || full) arm(0, sendNext);
    else if (!timer) arm(limits.lingerMs, sendNext);
  }

  return {
    totals,
    enqueue(entry) {
      if (stopped) return false;
      const room = entry.kind === 'output' ? limits.reservedRecords : 0;
      const roomBytes = entry.kind === 'output' ? limits.reservedBytes : 0;
      const fits = totals.queued < limits.maxRecords - room && bytes + entry.bytes <= limits.maxBytes - roomBytes;
      if (entry.kind !== 'session' && !fits) {
        const field = entry.kind === 'output' ? 'dropped' : 'markersDropped';
        totals[field]++;
        if (entry.account) entry.account[field]++;
        return false;
      }
      pending.push(entry);
      totals.queued++;
      bytes += entry.bytes;
      pendingBytes += entry.bytes;
      if (entry.account) entry.account.queued++;
      schedule();
      return true;
    },
    flush(budgetMs) {
      if (totals.queued === 0) return Promise.resolve(true);
      deadline = Date.now() + budgetMs;
      return new Promise<boolean>((resolve) => {
        // Deliberately ref'd: the flush is the one bounded wait that may hold the process open.
        const expire = setTimeout(() => finish(false), budgetMs);
        const finish = (drained: boolean) => {
          clearTimeout(expire);
          waiters.delete(onDrained);
          deadline = undefined;
          resolve(drained);
        };
        const onDrained = () => finish(true);
        waiters.add(onDrained);
        if (!waitingRetry) sendNext();
      });
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
