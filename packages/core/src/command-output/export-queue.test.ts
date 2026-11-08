import type { ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { describe, expect, it } from 'vitest';

import { createExportQueue, type DeliveryAccount, newAccount, type QueueEntry } from './export-queue.js';

const SUCCESS: ExportResult = { code: 0 };
const transient = (): ExportResult => ({ code: 1, error: new Error('Export failed with retryable status') });
const permanent = (): ExportResult => ({ code: 1, error: Object.assign(new Error('Bad Request'), { code: 400 }) });

interface Call {
  records: ReadableLogRecord[];
  done: (r: ExportResult) => void;
}

/** Exporter that records each export call; `answer` decides the result (undefined = never answer). */
function fakeExporter(answer: (n: number) => ExportResult | undefined = () => SUCCESS) {
  const calls: Call[] = [];
  return {
    calls,
    exporter: {
      export(records: ReadableLogRecord[], done: (r: ExportResult) => void) {
        calls.push({ records, done });
        const r = answer(calls.length);
        if (r) setImmediate(() => done(r));
      },
    },
  };
}

const resource = resourceFromAttributes({});
const record = (name: string): ReadableLogRecord => ({
  hrTime: [0, 0],
  hrTimeObserved: [0, 0],
  body: name,
  resource,
  instrumentationScope: { name: 'test' },
  attributes: {},
  droppedAttributesCount: 0,
});
function entry(name: string, account?: DeliveryAccount, kind: QueueEntry['kind'] = 'output', bytes = 10): QueueEntry {
  return { kind, bytes, account, barrier: kind !== 'output', build: () => record(name) };
}
const bodies = (calls: Call[]) => calls.map((c) => c.records.map((r) => r.body));
const fast = { initialMs: 5, maxMs: 20, windowMs: 2_000 };

describe('createExportQueue', () => {
  it('counts a record as delivered only when the exporter acknowledges it', async () => {
    let release: (() => void) | undefined;
    const { calls, exporter } = fakeExporter();
    const held = {
      export(records: ReadableLogRecord[], done: (r: ExportResult) => void) {
        release = () => exporter.export(records, done);
      },
    };
    const acc = newAccount();
    const q = createExportQueue({ exporter: held, exportTimeoutMs: 100, retry: fast });
    for (const n of ['a', 'b', 'c']) expect(q.enqueue(entry(n, acc))).toBe(true);
    const flushing = q.flush(2_000);
    await new Promise((r) => setTimeout(r, 30));
    expect(acc.acked).toBe(0);
    expect(acc.queued).toBe(3);
    release?.();
    expect(await flushing).toBe(true);
    expect(acc).toMatchObject({ acked: 3, queued: 0, failed: 0 });
    expect(bodies(calls)).toEqual([['a', 'b', 'c']]);
  });

  it('retries a transient failure with backoff until it is acknowledged', async () => {
    const { calls, exporter } = fakeExporter((n) => (n <= 2 ? transient() : SUCCESS));
    const acc = newAccount();
    const q = createExportQueue({ exporter, exportTimeoutMs: 100, retry: fast });
    q.enqueue(entry('a', acc));
    expect(await q.flush(2_000)).toBe(true);
    expect(calls).toHaveLength(3);
    expect(acc).toMatchObject({ acked: 1, failed: 0 });
    expect(q.totals).toMatchObject({ acked: 1, failed: 0, retries: 2 });
  });

  it('counts a permanent failure without retrying it', async () => {
    const { calls, exporter } = fakeExporter(() => permanent());
    const acc = newAccount();
    const q = createExportQueue({ exporter, exportTimeoutMs: 100, retry: fast });
    q.enqueue(entry('a', acc));
    q.enqueue(entry('b', acc));
    expect(await q.flush(2_000)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(acc).toMatchObject({ acked: 0, failed: 2, queued: 0 });
  });

  it('gives up on a transient failure once the retry window has passed and counts it failed', async () => {
    const { calls, exporter } = fakeExporter(() => transient());
    const acc = newAccount();
    const q = createExportQueue({ exporter, exportTimeoutMs: 50, retry: { initialMs: 10, maxMs: 40, windowMs: 200 } });
    q.enqueue(entry('a', acc));
    const started = Date.now();
    expect(await q.flush(5_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(calls.length).toBeGreaterThan(2);
    expect(acc).toMatchObject({ acked: 0, failed: 1 });
  });

  it('returns within the flush budget when the exporter never answers and leaves the rest unacknowledged', async () => {
    const { exporter } = fakeExporter(() => undefined);
    const acc = newAccount();
    const q = createExportQueue({ exporter, exportTimeoutMs: 100, retry: fast });
    q.enqueue(entry('a', acc));
    const started = Date.now();
    expect(await q.flush(300)).toBe(false);
    expect(Date.now() - started).toBeLessThan(800);
    expect(acc.acked).toBe(0);
    expect(q.totals.queued).toBe(1);
  });

  it('starts no export when the remaining flush budget is shorter than the export timeout', async () => {
    const { calls, exporter } = fakeExporter();
    const q = createExportQueue({ exporter, exportTimeoutMs: 1_000, limits: { lingerMs: 10_000 } });
    q.enqueue(entry('a', newAccount()));
    expect(await q.flush(200)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('sends a batch on its own once it lingers, without a flush', async () => {
    const { calls, exporter } = fakeExporter();
    const q = createExportQueue({ exporter, exportTimeoutMs: 100, limits: { lingerMs: 10 } });
    q.enqueue(entry('a', newAccount()));
    await new Promise((r) => setTimeout(r, 100));
    expect(bodies(calls)).toEqual([['a']]);
  });

  it('splits batches at the record and byte batch limits', async () => {
    const { calls, exporter } = fakeExporter();
    const q = createExportQueue({ exporter, exportTimeoutMs: 100, limits: { batchRecords: 2, batchBytes: 25 } });
    const acc = newAccount();
    for (const n of ['a', 'b', 'c']) q.enqueue(entry(n, acc));
    q.enqueue(entry('big', acc, 'output', 30));
    q.enqueue(entry('d', acc));
    expect(await q.flush(2_000)).toBe(true);
    expect(bodies(calls)).toEqual([['a', 'b'], ['c'], ['big'], ['d']]);
  });

  it('drops and counts output past the bounds, keeps reserved room for markers, and counts reserve exhaustion', async () => {
    const { exporter } = fakeExporter(() => undefined);
    const acc = newAccount();
    const limits = { maxRecords: 10, reservedRecords: 3, maxBytes: 1_000, reservedBytes: 100, lingerMs: 10_000 };
    const q = createExportQueue({ exporter, exportTimeoutMs: 100, limits });
    const admitted = Array.from({ length: 20 }, (_, i) => q.enqueue(entry(`o${i}`, acc)));
    expect(admitted.filter(Boolean)).toHaveLength(7);
    expect(acc.dropped).toBe(13);
    expect([1, 2, 3].map((i) => q.enqueue(entry(`end${i}`, acc, 'marker')))).toEqual([true, true, true]);
    expect(q.enqueue(entry('end4', acc, 'marker'))).toBe(false);
    expect(acc.markersDropped).toBe(1);
    expect(q.enqueue(entry('session-end', undefined, 'session'))).toBe(true);
    expect(q.totals).toMatchObject({ dropped: 13, markersDropped: 1, queued: 11 });
  });

  it('bounds queued output by bytes as well as records', () => {
    const { exporter } = fakeExporter(() => undefined);
    const acc = newAccount();
    const limits = { maxRecords: 100, reservedRecords: 1, maxBytes: 100, reservedBytes: 40, lingerMs: 10_000 };
    const q = createExportQueue({ exporter, exportTimeoutMs: 100, limits });
    expect([1, 2, 3, 4].map(() => q.enqueue(entry('o', acc, 'output', 25)))).toEqual([true, true, false, false]);
    expect(q.enqueue(entry('end', acc, 'marker', 40))).toBe(true);
    expect(acc.dropped).toBe(2);
  });

  it('builds a barrier entry only after every earlier entry has settled', async () => {
    const { calls, exporter } = fakeExporter();
    const acc = newAccount();
    const seen: number[] = [];
    const q = createExportQueue({ exporter, exportTimeoutMs: 100, retry: fast });
    q.enqueue(entry('a', acc));
    q.enqueue(entry('b', acc));
    q.enqueue({
      kind: 'marker',
      bytes: 10,
      account: acc,
      barrier: true,
      build: () => {
        seen.push(acc.acked);
        return record('end');
      },
    });
    q.enqueue(entry('c', acc));
    expect(await q.flush(2_000)).toBe(true);
    expect(bodies(calls)).toEqual([
      ['a', 'b'],
      ['end', 'c'],
    ]);
    expect(seen).toEqual([2]);
  });

  it('treats a throwing exporter as a transient failure', async () => {
    let n = 0;
    const exporter = {
      export(_r: ReadableLogRecord[], done: (r: ExportResult) => void) {
        if (++n === 1) throw new Error('boom');
        done(SUCCESS);
      },
    };
    const acc = newAccount();
    const q = createExportQueue({ exporter, exportTimeoutMs: 100, retry: fast });
    q.enqueue(entry('a', acc));
    expect(await q.flush(2_000)).toBe(true);
    expect(acc.acked).toBe(1);
  });
});
