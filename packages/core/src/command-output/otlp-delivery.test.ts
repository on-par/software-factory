import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type OtlpTestCollector, type OtlpTestRecord, startOtlpTestCollector } from '../testing/otlp-collector.js';
import { runCommand } from '../utils/command-runner.js';
import { createOtlpSink } from './otlp-sink.js';
import { closeCommandOutputSession, startCommandOutputSession } from './tap.js';

let collector: OtlpTestCollector;
const warnings: string[] = [];

async function enableExport(extra: Record<string, string> = {}) {
  collector = await startOtlpTestCollector();
  vi.stubEnv('FACTORY_COMMAND_STREAM_DIR', '');
  vi.stubEnv('FACTORY_COMMAND_OUTPUT_EXPORT', 'otlp');
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', collector.endpoint);
  vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json');
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  warnings.length = 0;
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(args.join(' ')));
});
afterEach(async () => {
  await closeCommandOutputSession('exit', 2_000);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await collector?.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ends = (rs: OtlpTestRecord[]) => rs.filter((r) => r.eventName === 'factory.command.end');
/** Prints `n` numbered lines, one every `everyMs`. */
const printer = (tag: string, n: number, everyMs: number) =>
  `let i = 0; const t = setInterval(() => { console.log('${tag} ' + i); if (++i === ${n}) clearInterval(t); }, ${everyMs});`;

describe('command output OTLP delivery', () => {
  it('recovers every record through a transient outage (503s, then refused connections)', async () => {
    await enableExport({ OTEL_EXPORTER_OTLP_TIMEOUT: '500' });
    await startCommandOutputSession({ version: 't' });
    await collector.setMode({ status: 503, retryAfterSeconds: 1 });
    const run = runCommand(['node', '-e', printer('OUTAGE', 60, 40)]);
    await sleep(1_000);
    await collector.setMode('refuse');
    await sleep(1_200);
    await collector.setMode('ok');
    await run;
    const summary = await closeCommandOutputSession('exit', 10_000);
    expect(summary).toMatchObject({ complete: true, exportFailed: 0, dropped: 0 });
    const records = collector.records();
    for (let i = 0; i < 60; i++) expect(records.filter((r) => r.body === `OUTAGE ${i}`)).toHaveLength(1);
    expect(ends(records)[0].attrs['factory.command.complete']).toBe(true);
    expect(collector.requests.some((r) => r.status === 503)).toBe(true);
    expect(summary?.retries).toBeGreaterThan(0);
  }, 60_000);

  it('counts permanently rejected records on the command end record and marks it incomplete', async () => {
    await enableExport();
    await startCommandOutputSession({ version: 't' });
    await collector.setMode({ status: 400 });
    const run = runCommand(['node', '-e', `${printer('REJECTED', 5, 10)} setTimeout(() => {}, 1500);`]);
    await sleep(700);
    await collector.setMode('ok');
    await run;
    const summary = await closeCommandOutputSession('exit', 10_000);
    expect(summary?.complete).toBe(false);
    expect(summary?.exportFailed).toBeGreaterThan(0);
    const end = ends(collector.records())[0];
    expect(end.attrs['factory.command.complete']).toBe(false);
    expect(Number(end.attrs['factory.command.export_failed'])).toBeGreaterThan(0);
    expect(warnings.filter((w) => w.includes('factory: command output export incomplete'))).toHaveLength(1);
  }, 60_000);

  it('returns within the flush budget when the collector never answers', async () => {
    await enableExport({ OTEL_EXPORTER_OTLP_TIMEOUT: '300' });
    await startCommandOutputSession({ version: 't' });
    await collector.setMode('hang');
    await runCommand(['node', '-e', "console.log('HUNG-LINE')"]);
    const started = Date.now();
    const summary = await closeCommandOutputSession('exit', 1_500);
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(summary?.complete).toBe(false);
    expect(collector.records()).toHaveLength(0);
  }, 30_000);

  it('drops and counts output past the queue bound but keeps the start and end markers', async () => {
    await enableExport({ OTEL_EXPORTER_OTLP_TIMEOUT: '300' });
    const sink = await createOtlpSink({
      version: 't',
      protocol: 'http/json',
      limits: { maxRecords: 40, reservedRecords: 8, lingerMs: 10 },
    });
    await collector.setMode('hang');
    const tap = sink.openCommand('test-000001', ['node', '-e', 'flood'], {});
    const child = spawn('node', ['-e', "for (let i = 0; i < 2000; i++) console.log('FLOOD ' + i)"]);
    child.stdout.on('data', (c: Buffer) => tap.write('stdout', c));
    const code = await new Promise<number | null>((r) => child.on('close', r));
    tap.end({ exitCode: code, signal: null, timedOut: false, maxBufferExceeded: false });
    await collector.setMode('ok');
    const summary = await sink.close('exit', 10_000);
    expect(summary.dropped).toBeGreaterThan(1_000);
    expect(summary.markersDropped).toBe(0);
    const records = collector.records();
    expect(records.some((r) => r.eventName === 'factory.command.start')).toBe(true);
    const end = ends(records)[0];
    expect(end.attrs).toMatchObject({ 'factory.command.complete': false });
    expect(Number(end.attrs['factory.command.dropped'])).toBe(summary.dropped);
    const session = records.find((r) => r.eventName === 'factory.session.end');
    expect(session?.attrs).toMatchObject({
      'factory.session.complete': false,
      'factory.session.dropped': summary.dropped,
    });
  }, 60_000);

  it('ends a command still running at close as interrupted and incomplete', async () => {
    await enableExport();
    await startCommandOutputSession({ version: 't' });
    const run = runCommand(['node', '-e', "console.log('STILL-RUNNING'); setTimeout(() => {}, 3000)"], {
      timeoutMs: 10_000,
    });
    await collector.waitFor((rs) => rs.some((r) => r.body === 'STILL-RUNNING'));
    const summary = await closeCommandOutputSession('signal', 5_000);
    expect(summary?.complete).toBe(false);
    const end = ends(collector.records())[0];
    expect(end.attrs).toMatchObject({ 'factory.command.interrupted': true, 'factory.command.complete': false });
    expect(
      collector.records().find((r) => r.eventName === 'factory.session.end')?.attrs['factory.session.reason'],
    ).toBe('signal');
    await run;
  }, 30_000);
});
