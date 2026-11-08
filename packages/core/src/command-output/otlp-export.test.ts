import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultStartApp } from '../checkers/app-smoke.js';
import { createTempDirs } from '../harness/temp-dir.js';
import {
  commandRecords,
  type OtlpTestCollector,
  type OtlpTestRecord,
  reassembleStream,
  startOtlpTestCollector,
} from '../testing/otlp-collector.js';
import { runCommand } from '../utils/command-runner.js';
import { defaultExecFn } from '../utils/exec.js';
import { collectKnownSecrets, createRedactor } from './redactor.js';
import { closeCommandOutputSession, startCommandOutputSession } from './tap.js';

const dirs = createTempDirs();
let collector: OtlpTestCollector;

const SECRET_ENV = {
  VENDOR_API_KEY: 'vendor-key-plainletters',
  OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer collectorcredentialvalue',
};
const GH = `ghp_${'Zz9Yy8Xx7W'.repeat(4)}`;
const FINAL = 'AssertionError: expected 41 to equal 42 (at final.test.ts:99:7)';

async function enableExport(protocol: 'http/json' | 'http/protobuf' = 'http/json') {
  collector = await startOtlpTestCollector();
  vi.stubEnv('FACTORY_COMMAND_STREAM_DIR', '');
  vi.stubEnv('FACTORY_COMMAND_OUTPUT_EXPORT', 'otlp');
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', collector.endpoint);
  vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', protocol);
  for (const [k, v] of Object.entries(SECRET_ENV)) vi.stubEnv(k, v);
  await startCommandOutputSession({ version: '0.0.0-test' });
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(async () => {
  await closeCommandOutputSession('exit', 2_000);
  vi.unstubAllEnvs();
  await collector?.close();
  await dirs.cleanup();
});

const event = (records: OtlpTestRecord[], name: string) => records.filter((r) => r.eventName === name);
const startOf = (records: OtlpTestRecord[], needle: string) =>
  event(records, 'factory.command.start').find((r) => String(r.attrs['process.command_line']).includes(needle));

/** ~1 KiB lines of words with a secret every 40 lines; multibyte text on every line. */
function block(tag: string, lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const secret =
      i % 40 === 0 ? ` key ${SECRET_ENV.VENDOR_API_KEY} gh ${GH} auth Bearer collectorcredentialvalue` : '';
    out.push(`${tag} ${i} é 漢字 🚀 ${'lorem ipsum dolor sit amet '.repeat(36)}${secret}`);
  }
  return `${out.join('\n')}\n`;
}

/** Writes BEGIN and MIDDLE, blocks until `release` exists, then writes the tail and the final failing line. */
const CHILD = `
const fs = require('fs');
const [dir, release] = process.argv.slice(1);
const read = (n) => fs.readFileSync(dir + '/' + n);
const write = (s, b) => new Promise((r) => s.write(b, r));
(async () => {
  for (const part of ['begin', 'middle']) {
    await write(process.stdout, read('out-' + part));
    await write(process.stderr, read('err-' + part));
  }
  while (!fs.existsSync(release)) await new Promise((r) => setTimeout(r, 20));
  await write(process.stdout, read('out-tail'));
  await write(process.stderr, read('err-tail'));
})();
`;

describe('command output OTLP export (real child, mock collector)', () => {
  it('exports begin and middle while the child runs, then the tail, byte-exact after redaction', async () => {
    await enableExport();
    const dir = await dirs.make('sf-otlp-big-');
    const parts: Record<string, string> = {};
    for (const s of ['out', 'err']) {
      const tag = s === 'out' ? 'STDOUT' : 'STDERR';
      parts[`${s}-begin`] = `BEGIN-${tag}\n${block(`b-${s}`, 300)}`;
      parts[`${s}-middle`] = `MIDDLE-${tag}\n${block(`m-${s}`, 300)}`;
      // stdout ends with the failing line and a newline; stderr ends with it and no newline (an unterminated tail).
      const last = s === 'out' ? `${FINAL}\n` : FINAL;
      parts[`${s}-tail`] = `${block(`t-${s}`, 300)}${last}`;
    }
    for (const [name, text] of Object.entries(parts)) writeFileSync(join(dir, name), text);
    const release = join(dir, 'release');

    let settled = false;
    const run = runCommand(['node', '-e', CHILD, dir, release], { timeoutMs: 120_000, maxBuffer: 64 * 1024 * 1024 });
    void run.then(() => (settled = true));

    const has = (rs: OtlpTestRecord[], body: string) => rs.some((r) => r.body === body);
    await collector.waitFor(
      (rs) => ['BEGIN-STDOUT', 'BEGIN-STDERR', 'MIDDLE-STDOUT', 'MIDDLE-STDERR'].every((b) => has(rs, b)),
      30_000,
    );
    expect(settled).toBe(false);
    expect(has(collector.records(), FINAL)).toBe(false);
    writeFileSync(release, '');
    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(900_000);

    const summary = await closeCommandOutputSession('exit', 10_000);
    expect(summary).toMatchObject({ complete: true, dropped: 0, exportFailed: 0, markersDropped: 0 });
    const records = collector.records();
    const start = startOf(records, 'node');
    const id = String(start?.attrs['factory.command.id']);
    expect(id).toMatch(/^\d+-\d+-\d{6}$/);

    const redact = createRedactor(collectKnownSecrets(process.env)).redact;
    const expected = (s: 'out' | 'err') =>
      ['begin', 'middle', 'tail']
        .map((p) => parts[`${s}-${p}`])
        .join('')
        .split('\n')
        .map((line) => redact(line))
        .join('\n');
    const stdout = reassembleStream(records, id, 'stdout');
    const stderr = reassembleStream(records, id, 'stderr');
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(750 * 1024);
    expect(Buffer.byteLength(stderr)).toBeGreaterThan(750 * 1024);
    expect(stdout === expected('out')).toBe(true);
    expect(stderr === expected('err')).toBe(true);
    expect(stdout.endsWith(`${FINAL}\n`)).toBe(true);
    expect(stderr.endsWith(FINAL)).toBe(true);
    const all = JSON.stringify(records);
    for (const leak of [SECRET_ENV.VENDOR_API_KEY, GH, 'collectorcredentialvalue']) expect(all).not.toContain(leak);

    const own = commandRecords(records, id);
    const seqs = own.map((r) => Number(r.attrs['factory.command.seq']));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const sessionIds = new Set(records.map((r) => r.resource['factory.session.id']));
    expect(sessionIds.size).toBe(1);
    expect(records.every((r) => r.scope === 'factory.command_output')).toBe(true);
    const end = event(own, 'factory.command.end')[0];
    expect(end.attrs).toMatchObject({
      'factory.command.complete': true,
      'factory.command.dropped': 0,
      'factory.command.export_failed': 0,
      'process.exit.code': 0,
      'factory.command.stdout.bytes': Buffer.byteLength(
        Object.keys(parts)
          .filter((k) => k.startsWith('out'))
          .map((k) => parts[k])
          .join(''),
      ),
    });
    expect(end.attrs['factory.command.stdout.records']).toBe(
      event(own, 'factory.command.output').filter((r) => r.attrs['log.iostream'] === 'stdout').length,
    );
    expect(event(records, 'factory.session.start')).toHaveLength(1);
    expect(event(records, 'factory.session.end')[0].attrs).toMatchObject({
      'factory.session.complete': true,
      'factory.session.commands': 1,
    });
  }, 120_000);

  it('covers the shell exec path, the detached runner path and the app_smoke app boot', async () => {
    await enableExport();
    await defaultExecFn(
      `node -e "console.log('EXEC-PATH-LINE'); console.error('EXEC-ERR ' + process.argv[1])" ${GH}`,
      {},
    );
    await runCommand(['node', '-e', "console.log('DETACHED-PATH-LINE')"], { onPgid: () => {} });
    const app = defaultStartApp(['node', '-e', "console.log('APP-SMOKE-LINE'); setTimeout(() => {}, 200)"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      onPgid: () => {},
    });
    await app.exited;
    expect(await closeCommandOutputSession('exit', 10_000)).toMatchObject({ complete: true, commands: 3 });
    const records = collector.records();
    for (const line of ['EXEC-PATH-LINE', 'DETACHED-PATH-LINE', 'APP-SMOKE-LINE'])
      expect(records.some((r) => r.body === line)).toBe(true);
    expect(records.some((r) => r.body === 'EXEC-ERR [redacted]')).toBe(true);
    const exec = startOf(records, 'EXEC-PATH-LINE');
    expect(exec?.attrs['factory.command.shell']).toBe(true);
    expect(String(exec?.attrs['process.command_line'])).not.toContain(GH);
    expect(event(records, 'factory.command.end').every((r) => r.attrs['factory.command.complete'] === true)).toBe(true);
  }, 60_000);

  it('uses http/protobuf by default and the payload decodes as standard OTLP protobuf', async () => {
    await enableExport('http/protobuf');
    vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', '');
    await runCommand(['node', '-e', "console.log('PROTOBUF-LINE é 🚀')"]);
    expect(await closeCommandOutputSession('exit', 10_000)).toMatchObject({ complete: true });
    expect(collector.requests.every((r) => r.contentType === 'application/x-protobuf')).toBe(true);
    const records = collector.records();
    expect(records.some((r) => r.body === 'PROTOBUF-LINE é 🚀')).toBe(true);
    expect(records[0].resource['service.name']).toBe('factory');
    expect(records[0].resource['service.version']).toBe('0.0.0-test');
  }, 60_000);

  it('adds the run id from FACTORY_RUN_ID and honors OTEL_SERVICE_NAME', async () => {
    vi.stubEnv('FACTORY_RUN_ID', 'run-123');
    vi.stubEnv('OTEL_SERVICE_NAME', 'factory-under-test');
    await enableExport();
    await runCommand(['node', '-e', "console.log('RUN-ID-LINE')"]);
    await closeCommandOutputSession('exit', 10_000);
    const line = collector.records().find((r) => r.body === 'RUN-ID-LINE');
    expect(line?.resource).toMatchObject({ 'factory.run.id': 'run-123', 'service.name': 'factory-under-test' });
  }, 60_000);
});
