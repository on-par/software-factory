import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { openCommandCapture } from './capture.js';
import { withCommandOutputExport } from './otlp-export.js';

const corr = { runId: 'run-recv', issue: '3995', lane: 'issue-3995', phase: 'check' };
const servers: Server[] = [];
const saved = { ...process.env };

afterEach(async () => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function listen(onPost?: (url: string, body: string) => void): Promise<number> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      onPost?.(req.url ?? '', Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

function emit(lines: string[]): void {
  const cap = openCommandCapture();
  for (const l of lines) cap?.onChunk('stdout', `${l}\n`);
  cap?.close();
}

describe('OTLP/HTTP export through the official exporter', () => {
  it('delivers redacted command output to a local OTLP/HTTP receiver through the official exporter', async () => {
    const posts: Array<{ url: string; body: string }> = [];
    const port = await listen((url, body) => posts.push({ url, body }));
    const env = {
      FACTORY_COMMAND_OUTPUT_EXPORT: 'otlp',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    };
    Object.assign(process.env, env);
    const token = ['ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
    const logs: Array<{ type: string; msg: string }> = [];
    await withCommandOutputExport(
      corr,
      (type, msg) => logs.push({ type, msg }),
      async () => emit([`token ${token} done`]),
      {
        env,
      },
    );
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/v1/logs');
    expect(posts[0].body).toContain('done');
    expect(posts[0].body).toContain('factory.run_id');
    expect(posts[0].body).toContain('run-recv');
    expect(posts[0].body).not.toContain(token);
    expect(logs).toEqual([
      { type: 'command_output_export', msg: 'command output export: 1 sent, 0 dropped, 0 failed (0 retries)' },
    ]);
  });

  it('exports with the default protobuf protocol', async () => {
    const posts: string[] = [];
    const port = await listen((url) => posts.push(url));
    const env = { FACTORY_COMMAND_OUTPUT_EXPORT: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` };
    Object.assign(process.env, env, { OTEL_EXPORTER_OTLP_TIMEOUT: '1000' });
    const logs: string[] = [];
    await withCommandOutputExport(
      corr,
      (_t, msg) => logs.push(msg),
      async () => emit(['hello']),
      {
        env: { ...env, OTEL_EXPORTER_OTLP_TIMEOUT: '1000' },
      },
    );
    expect(posts).toEqual(['/v1/logs']);
    expect(logs[0]).toContain('1 sent');
  });

  it('an unreachable endpoint counts failures and does not throw', async () => {
    const port = await listen();
    await new Promise((r) => servers.pop()?.close(r));
    const env = {
      FACTORY_COMMAND_OUTPUT_EXPORT: 'otlp',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    };
    Object.assign(process.env, env);
    const logs: Array<{ type: string; msg: string }> = [];
    const result = await withCommandOutputExport(
      corr,
      (type, msg) => logs.push({ type, msg }),
      async () => (emit(['lost']), 'still-fine'),
      { env, flushBudgetMs: 3000, retry: { initialMs: 1, maxMs: 5, maxAttempts: 2 } },
    );
    expect(result).toBe('still-fine');
    expect(logs).toHaveLength(1);
    expect(logs[0].type).toBe('command_output_export_degraded');
    expect(logs[0].msg).toMatch(/1 failed/);
  });
});
