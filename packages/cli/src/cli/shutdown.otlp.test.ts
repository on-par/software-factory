import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '@on-par/factory-core/testing';

interface Post {
  at: number;
  body: string;
}

const HEADER_VALUE = 's3cr3t-header-value';
const TOKEN = ['ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
const GITHUB_TOKEN = ['gh', 'o_', 'zyxwvutsrqponmlkjihgfedcba9876543210'].join('');
const allBodies: string[] = [];

describe.runIf(process.platform === 'linux')('OTLP export flush on exit and signals (mock collector)', () => {
  let server: Server;
  let posts: Post[];
  const tempDirs = createTempDirs();
  let child: ChildProcess | undefined;
  let tmp: string;
  let endpoint: string;

  beforeEach(async () => {
    posts = [];
    tmp = tempDirs.makeSync('otlp-proof-');
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (req.url === '/v1/logs') {
          posts.push({ at: performance.now(), body });
          allBodies.push(body);
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    child?.kill('SIGKILL');
    await new Promise((r) => server.close(r));
    await tempDirs.cleanup();
  });

  function childSource(mode: 'exit' | 'hang'): string {
    const shutdownUrl = pathToFileURL(join(import.meta.dirname, 'shutdown.ts')).href;
    const script = [
      `echo ${TOKEN}`,
      `echo ${HEADER_VALUE}`,
      'echo "env $GITHUB_TOKEN"',
      'echo stderr-line >&2',
      mode === 'exit' ? 'exit 0' : 'echo ready; sleep 10',
    ].join('; ');
    return `
import { installShutdown } from ${JSON.stringify(shutdownUrl)};
import { withCommandOutputExport, runVerificationCommand } from '@on-par/factory-core/internal';
installShutdown(new AbortController(), { stopFile: () => ${JSON.stringify(join(tmp, 'STOP'))}, killTracked: async () => {} });
const log = () => {};
await withCommandOutputExport(
  { runId: 'run-otlp-proof', issue: '3996', lane: 'issue-3996', phase: 'check' },
  log,
  () => runVerificationCommand(['sh', '-c', ${JSON.stringify(script)}], { cwd: ${JSON.stringify(tmp)}, timeoutMs: 20000 }),
);
`;
  }

  function start(mode: 'exit' | 'hang'): { exited: Promise<{ code: number | null; at: number }> } {
    child = spawn(
      process.execPath,
      ['--conditions=development', '--import', 'tsx', '--input-type=module', '-e', childSource(mode)],
      {
        env: {
          ...process.env,
          FACTORY_COMMAND_OUTPUT_EXPORT: 'otlp',
          OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
          OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
          OTEL_EXPORTER_OTLP_HEADERS: `authorization=Bearer ${HEADER_VALUE}`,
          GITHUB_TOKEN,
        },
        stdio: 'ignore',
      },
    );
    const exited = new Promise<{ code: number | null; at: number }>((resolve) => {
      child?.on('exit', (code) => resolve({ code, at: performance.now() }));
    });
    return { exited };
  }

  const waitReady = async (): Promise<void> => {
    const deadline = Date.now() + 20000;
    while (!posts.some((p) => p.body.includes('ready'))) {
      if (Date.now() > deadline) throw new Error('collector never received the ready line');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it('normal exit delivers redacted correlated stdout/stderr and session.end to the collector before the child exits', async () => {
    const { exited } = start('exit');
    const { code, at } = await exited;
    expect(code).toBe(0);
    const text = posts.map((p) => p.body).join('\n');
    expect(text).toContain('stderr-line');
    expect(text).toContain('"stdout"');
    expect(text).toContain('"stderr"');
    expect(text).toContain('run-otlp-proof');
    expect(text).toContain('session.start');
    expect(text).toContain('session.end');
    const lastEnd = [...posts].reverse().find((p) => p.body.includes('session.end'));
    expect(lastEnd?.at).toBeLessThan(at);
  }, 30000);

  it.each(['SIGINT', 'SIGTERM'] as const)(
    '%s flushes session.end interrupted to the collector and exits 130',
    async (signal) => {
      const { exited } = start('hang');
      await waitReady();
      child?.kill(signal);
      const { code, at } = await exited;
      expect(code).toBe(130);
      const end = posts.find(
        (p) => p.body.includes('session.end') && p.body.includes('interrupted') && p.body.includes(signal),
      );
      expect(end).toBeDefined();
      expect(end?.at).toBeLessThan(at);
    },
    30000,
  );

  it('no secret from output, env or OTLP headers reaches the collector', async () => {
    const { exited } = start('exit');
    await exited;
    const text = [...allBodies, ...posts.map((p) => p.body)].join('\n');
    expect(text.length).toBeGreaterThan(0);
    for (const secret of [TOKEN, HEADER_VALUE, GITHUB_TOKEN]) expect(text).not.toContain(secret);
  }, 30000);
});
