import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openCommandCapture, withCommandOutputScope } from './capture.js';
import { flushCommandOutputExports, resolveCommandOutputExport, withCommandOutputExport } from './otlp-export.js';

const corr = { runId: 'run-1', issue: '3995', lane: 'issue-3995', phase: 'check' };
const ON = { FACTORY_COMMAND_OUTPUT_EXPORT: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' };

interface Fake {
  exporter: LogRecordExporter;
  records: ReadableLogRecord[];
  shutdown: ReturnType<typeof vi.fn>;
}

function fakeExporter(mode: 'ok' | 'fail' | 'hang' | 'throw' = 'ok'): Fake {
  const records: ReadableLogRecord[] = [];
  const shutdown = vi.fn(async () => {});
  const exporter: LogRecordExporter = {
    export(batch, cb) {
      if (mode === 'throw') throw new Error('exporter exploded');
      records.push(...batch);
      if (mode === 'hang') return;
      cb({ code: mode === 'ok' ? 0 : 1 });
    },
    forceFlush: async () => {},
    shutdown,
  };
  return { exporter, records, shutdown };
}

const outputBodies = (records: ReadableLogRecord[]): string[] =>
  records.filter((r) => r.attributes['factory.event'] === undefined).map((r) => String(r.body).trimEnd());

function emitLines(lines: string[], stream: 'stdout' | 'stderr' = 'stdout'): void {
  const cap = openCommandCapture();
  for (const l of lines) cap?.onChunk(stream, `${l}\n`);
  cap?.close();
}

async function run(
  env: Record<string, string | undefined>,
  fn: () => Promise<unknown>,
  fake: Fake,
  extra: Parameters<typeof withCommandOutputExport>[3] = {},
) {
  const logs: Array<{ type: string; msg: string }> = [];
  const result = await withCommandOutputExport(corr, (type, msg) => logs.push({ type, msg }), fn, {
    env,
    createExporter: async () => fake.exporter,
    ...extra,
  });
  return { result, logs };
}

afterEach(() => vi.unstubAllGlobals());

describe('resolveCommandOutputExport', () => {
  const off = { enabled: false };
  it.each([
    ['unset', {}, off],
    ['wrong value', { FACTORY_COMMAND_OUTPUT_EXPORT: 'console' }, off],
    ['sdk disabled', { ...ON, OTEL_SDK_DISABLED: ' TRUE ' }, off],
    ['sdk disabled false', { ...ON, OTEL_SDK_DISABLED: 'false' }, { enabled: true, protocol: 'http/protobuf' }],
    ['exporter none', { ...ON, OTEL_LOGS_EXPORTER: 'console, none' }, off],
    [
      'console only',
      { ...ON, OTEL_LOGS_EXPORTER: 'console' },
      { enabled: false, warning: 'command output export disabled: OTEL_LOGS_EXPORTER does not include otlp' },
    ],
    ['empty exporter list', { ...ON, OTEL_LOGS_EXPORTER: ' , ' }, { enabled: true, protocol: 'http/protobuf' }],
    ['console and otlp', { ...ON, OTEL_LOGS_EXPORTER: 'console,OTLP' }, { enabled: true, protocol: 'http/protobuf' }],
    [
      'missing endpoint',
      { FACTORY_COMMAND_OUTPUT_EXPORT: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: '  ' },
      {
        enabled: false,
        warning: 'command output export disabled: set OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
      },
    ],
    [
      'logs endpoint only',
      { FACTORY_COMMAND_OUTPUT_EXPORT: 'otlp', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://x' },
      { enabled: true, protocol: 'http/protobuf' },
    ],
    [
      'grpc',
      { ...ON, OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' },
      {
        enabled: false,
        warning: "command output export disabled: unsupported OTLP protocol 'grpc' (use http/protobuf or http/json)",
      },
    ],
    [
      'unknown logs protocol',
      { ...ON, OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'carrier-pigeon' },
      {
        enabled: false,
        warning:
          "command output export disabled: unsupported OTLP protocol 'carrier-pigeon' (use http/protobuf or http/json)",
      },
    ],
    [
      'empty protocol is unset',
      { ...ON, OTEL_EXPORTER_OTLP_PROTOCOL: ' ' },
      { enabled: true, protocol: 'http/protobuf' },
    ],
    [
      'logs protocol wins',
      { ...ON, OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc', OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json' },
      { enabled: true, protocol: 'http/json' },
    ],
  ])('%s', (_name, env, expected) => {
    expect(resolveCommandOutputExport(env)).toEqual(expected);
  });
});

describe('withCommandOutputExport', () => {
  it('is disabled by default and never creates an exporter or registers a sink', async () => {
    const createExporter = vi.fn();
    const logs: string[] = [];
    const result = await withCommandOutputExport(
      corr,
      (t) => logs.push(t),
      async () => openCommandCapture(),
      {
        env: {},
        createExporter,
      },
    );
    expect(result).toBeUndefined();
    expect(createExporter).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
    expect(
      await withCommandOutputExport(
        corr,
        () => {},
        async () => 'value',
        { env: {} },
      ),
    ).toBe('value');
  });

  it('OTEL_SDK_DISABLED=true vetoes an explicit opt-in with no exporter and no network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const createExporter = vi.fn();
    const logs: string[] = [];
    const result = await withCommandOutputExport(
      corr,
      (t) => logs.push(t),
      async () => openCommandCapture(),
      {
        env: { ...ON, OTEL_SDK_DISABLED: 'TRUE' },
        createExporter,
      },
    );
    expect(result).toBeUndefined();
    expect(createExporter).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it('OTEL_LOGS_EXPORTER=none vetoes an explicit opt-in', async () => {
    const createExporter = vi.fn();
    await withCommandOutputExport(
      corr,
      () => {},
      async () => 1,
      {
        env: { ...ON, OTEL_LOGS_EXPORTER: 'none' },
        createExporter,
      },
    );
    expect(createExporter).not.toHaveBeenCalled();
  });

  it('logs command_output_export_degraded for a missing endpoint and still runs fn', async () => {
    const fake = fakeExporter();
    const { result, logs } = await run({ FACTORY_COMMAND_OUTPUT_EXPORT: 'otlp' }, async () => 7, fake);
    expect(result).toBe(7);
    expect(logs).toEqual([
      {
        type: 'command_output_export_degraded',
        msg: 'command output export disabled: set OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
      },
    ]);
  });

  it('exports one record per redacted line with correlation attributes', async () => {
    const fake = fakeExporter();
    await run(ON, async () => emitLines(['alpha', 'beta']), fake);
    await run(ON, async () => emitLines(['oops'], 'stderr'), fake);
    expect(outputBodies(fake.records)).toEqual(['alpha', 'beta', 'oops']);
    const out = fake.records.filter((r) => r.attributes['factory.event'] === undefined);
    expect(out[0].attributes).toEqual({
      'factory.run_id': 'run-1',
      'factory.issue': '3995',
      'factory.lane': 'issue-3995',
      'factory.phase': 'check',
      'factory.session_id': expect.stringMatching(/^[0-9a-f]{8}$/),
      'factory.command_id': 'cmd-0',
      'factory.seq': 0,
      'log.iostream': 'stdout',
    });
    expect(out[1].attributes['factory.seq']).toBe(1);
    expect(out[2].attributes['log.iostream']).toBe('stderr');
    expect(out[2].severityNumber).toBe(13);
    expect(out[0].severityNumber).toBe(9);
    expect(fake.records[0].resource.attributes['service.name']).toBe('software-factory');
  });

  it('honors OTEL_SERVICE_NAME', async () => {
    const fake = fakeExporter();
    await run({ ...ON, OTEL_SERVICE_NAME: 'my-factory' }, async () => emitLines(['a']), fake);
    expect(fake.records[0].resource.attributes['service.name']).toBe('my-factory');
  });

  it('ignores records from other runs', async () => {
    const fake = fakeExporter();
    await run(
      ON,
      async () => {
        await withCommandOutputScope({ ...corr, runId: 'other' }, async () => emitLines(['foreign']));
        emitLines(['mine']);
      },
      fake,
    );
    expect(outputBodies(fake.records)).toEqual(['mine']);
  });

  it('never passes a planted token, private key or OTLP header value to the exporter', async () => {
    const fake = fakeExporter();
    const token = ['ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAplantedkeymaterial',
      '-----END RSA PRIVATE KEY-----',
    ];
    const { logs } = await run(
      { ...ON, OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=s3cr3tHeaderValue,bad,short=ab,pct=%E0%A4%A' },
      async () => emitLines([`token ${token}`, ...pem, 'header s3cr3tHeaderValue here', 'pct %E0%A4%A end']),
      fake,
    );
    const wire = JSON.stringify(fake.records);
    expect(wire).not.toContain(token);
    expect(wire).not.toContain('plantedkeymaterial');
    expect(wire).not.toContain('s3cr3tHeaderValue');
    expect(wire).not.toContain('%E0%A4%A');
    expect(wire).toContain('<secret>');
    expect(JSON.stringify(logs)).not.toContain('s3cr3tHeaderValue');
  });

  it('masks the bare credential of a scheme-prefixed OTLP header value', async () => {
    const fake = fakeExporter();
    await run(
      { ...ON, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer tok3n-value-xyz' },
      async () => emitLines(['bare tok3n-value-xyz', 'full Bearer tok3n-value-xyz']),
      fake,
    );
    expect(JSON.stringify(fake.records)).not.toContain('tok3n-value-xyz');
  });

  it('logs command_output_export with sent, dropped and failed counts when nothing is lost', async () => {
    const fake = fakeExporter();
    const { logs, result } = await run(ON, async () => (emitLines(['a', 'b', 'c']), 'done'), fake);
    expect(result).toBe('done');
    expect(logs).toEqual([
      { type: 'command_output_export', msg: 'command output export: 5 sent, 0 dropped, 0 failed (0 retries)' },
    ]);
    expect(fake.shutdown).toHaveBeenCalledOnce();
  });

  it('logs command_output_export_degraded with the dropped count on queue overflow', async () => {
    const fake = fakeExporter();
    const { logs } = await run(ON, async () => emitLines(['1', '2', '3', '4', '5']), fake, { maxQueued: 2 });
    expect(logs).toHaveLength(1);
    expect(logs[0].type).toBe('command_output_export_degraded');
    expect(logs[0].msg).toBe('command output export: 2 sent, 5 dropped, 0 failed (0 retries)');
  });

  it('logs command_output_export_degraded with the failed count when every export fails', async () => {
    const fake = fakeExporter('fail');
    const { logs } = await run(ON, async () => emitLines(['1', '2']), fake, {
      retry: { initialMs: 1, maxAttempts: 2 },
    });
    expect(logs[0].type).toBe('command_output_export_degraded');
    expect(logs[0].msg).toBe('command output export: 0 sent, 0 dropped, 4 failed (1 retries)');
  });

  it("returns fn's result within the flush budget when the exporter hangs", async () => {
    const fake = fakeExporter('hang');
    const start = Date.now();
    const { result, logs } = await run(ON, async () => (emitLines(['1']), 'ok'), fake, { flushBudgetMs: 50 });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(result).toBe('ok');
    expect(logs[0].type).toBe('command_output_export_degraded');
    expect(logs[0].msg).toContain('3 failed');
  });

  it("swallows a throwing exporter and still returns fn's result", async () => {
    const fake = fakeExporter('throw');
    const { result, logs } = await run(ON, async () => (emitLines(['1']), 'ok'), fake, {
      retry: { initialMs: 1, maxAttempts: 2 },
    });
    expect(result).toBe('ok');
    expect(logs[0].msg).toContain('3 failed');
  });

  it('swallows a throwing exporter shutdown and a throwing log', async () => {
    const fake = fakeExporter();
    fake.shutdown.mockRejectedValue(new Error('shutdown failed'));
    const result = await withCommandOutputExport(
      corr,
      () => {
        throw new Error('log failed');
      },
      async () => 'ok',
      { env: ON, createExporter: async () => fake.exporter },
    );
    expect(result).toBe('ok');
  });

  it("propagates fn's own error unchanged", async () => {
    const fake = fakeExporter();
    const err = new Error('fn failed');
    await expect(run(ON, () => Promise.reject(err), fake)).rejects.toBe(err);
    expect(fake.shutdown).toHaveBeenCalledOnce();
  });

  it('falls back to plain capture when exporter setup throws', async () => {
    const logs: Array<{ type: string; msg: string }> = [];
    const result = await withCommandOutputExport(
      corr,
      (type, msg) => logs.push({ type, msg }),
      async () => 'ok',
      {
        env: ON,
        createExporter: async () => {
          throw new Error('no such module');
        },
      },
    );
    expect(result).toBe('ok');
    expect(logs).toEqual([
      { type: 'command_output_export_degraded', msg: 'command output export disabled: setup failed: no such module' },
    ]);
  });

  it('stringifies a non-Error setup failure', async () => {
    const logs: string[] = [];
    await withCommandOutputExport(
      corr,
      (_t, msg) => logs.push(msg),
      async () => 1,
      {
        env: ON,
        createExporter: () => Promise.reject('plain'),
      },
    );
    expect(logs[0]).toContain('setup failed: plain');
  });
});

describe('export sessions', () => {
  const evt = (r: ReadableLogRecord) => r.attributes['factory.event'];

  it('emits session.start before output and session.end last with the run correlation', async () => {
    const fake = fakeExporter();
    await run(ON, async () => emitLines(['x']), fake);
    expect(fake.records.map((r) => evt(r) ?? 'output')).toEqual(['session.start', 'output', 'session.end']);
    const [start, out, end] = fake.records;
    expect(start.body).toBe('session start');
    expect(end.body).toBe('session end');
    expect(end.attributes['factory.session.status']).toBe('ok');
    expect(end.attributes['factory.signal']).toBeUndefined();
    for (const r of [start, end]) {
      expect(r.attributes).toMatchObject({
        'factory.run_id': 'run-1',
        'factory.issue': '3995',
        'factory.lane': 'issue-3995',
        'factory.phase': 'check',
        'factory.session_id': out.attributes['factory.session_id'],
      });
    }
  });

  it('marks a throwing fn as status error', async () => {
    const fake = fakeExporter();
    await expect(run(ON, () => Promise.reject(new Error('x')), fake)).rejects.toThrow('x');
    expect(fake.records.at(-1)?.attributes['factory.session.status']).toBe('error');
  });

  it('session end is idempotent when a signal flush races the normal finally', async () => {
    const fake = fakeExporter();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const logs: Array<{ type: string; msg: string }> = [];
    const done = withCommandOutputExport(
      corr,
      (type, msg) => logs.push({ type, msg }),
      async () => gate,
      { env: ON, createExporter: async () => fake.exporter },
    );
    await vi.waitFor(() => expect(fake.records.length).toBeGreaterThan(0));
    const reports = await flushCommandOutputExports('SIGINT');
    release();
    await done;
    expect(reports).toHaveLength(1);
    expect(fake.records.filter((r) => evt(r) === 'session.end')).toHaveLength(1);
    expect(fake.shutdown).toHaveBeenCalledOnce();
    expect(logs).toHaveLength(1);
  });

  it('a flush that exceeds its budget counts the unsent records and the session end as failed and logs degraded', async () => {
    const fake = fakeExporter('hang');
    const { logs } = await run(ON, async () => emitLines(['1', '2']), fake, { flushBudgetMs: 50 });
    expect(logs).toHaveLength(1);
    expect(logs[0].type).toBe('command_output_export_degraded');
    expect(logs[0].msg).toMatch(/0 sent, 0 dropped, \d+ failed/);
    const failed = Number(/(\d+) failed/.exec(logs[0].msg)?.[1]);
    expect(failed).toBeGreaterThanOrEqual(3);
  });

  it('flushCommandOutputExports ends active sessions as interrupted with the signal and returns their reports', async () => {
    const fake = fakeExporter();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const logs: Array<{ type: string; msg: string }> = [];
    const done = withCommandOutputExport(
      corr,
      (type, msg) => logs.push({ type, msg }),
      async () => gate,
      { env: ON, createExporter: async () => fake.exporter },
    );
    await vi.waitFor(() => expect(fake.records.length).toBeGreaterThan(0));
    const reports = await flushCommandOutputExports('SIGTERM', 1000);
    expect(reports).toEqual([
      expect.objectContaining({ runId: 'run-1', sessionId: expect.any(String), complete: true, sent: 2 }),
    ]);
    const end = fake.records.find((r) => evt(r) === 'session.end');
    expect(end?.attributes).toMatchObject({ 'factory.session.status': 'interrupted', 'factory.signal': 'SIGTERM' });
    expect(logs[0]).toEqual({
      type: 'command_output_export_degraded',
      msg: 'command output export: 2 sent, 0 dropped, 0 failed (0 retries); session interrupted by SIGTERM',
    });
    release();
    await done;
    expect(await flushCommandOutputExports('SIGINT')).toEqual([]);
  });

  it('disabled export opens no session and flushCommandOutputExports resolves empty without an exporter', async () => {
    const createExporter = vi.fn();
    await withCommandOutputExport(
      corr,
      () => {},
      async () => {
        expect(await flushCommandOutputExports('SIGINT')).toEqual([]);
      },
      { env: {}, createExporter },
    );
    expect(createExporter).not.toHaveBeenCalled();
  });
});
