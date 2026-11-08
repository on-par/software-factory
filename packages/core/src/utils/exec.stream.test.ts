import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { defaultExecFn } from './exec.js';

const dirs = createTempDirs();
afterEach(async () => {
  vi.unstubAllEnvs();
  await dirs.cleanup();
});

const OUT = `out-begin é 漢字 🚀\n${'x'.repeat(200_000)}\nout-end\n`;
const ERR = `err-begin ñ\n${'y'.repeat(100_000)}\nerr-end\n`;

async function setup(exitCode: number) {
  const work = await dirs.make('sf-exec-stream-');
  const script = join(work, 'child.js');
  writeFileSync(
    script,
    `process.stdout.write(${JSON.stringify(OUT)}); process.stderr.write(${JSON.stringify(ERR)}, () => { process.exitCode = ${exitCode}; });`,
  );
  const streamDir = join(work, 'streams');
  vi.stubEnv('FACTORY_COMMAND_STREAM_DIR', streamDir);
  return { cmd: `"${process.execPath}" "${script}"`, streamDir };
}

function read(streamDir: string) {
  const files = readdirSync(streamDir);
  expect(files).toHaveLength(1);
  const lines = readFileSync(join(streamDir, files[0]), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const bytes = (stream: string) =>
    Buffer.concat(
      lines.filter((l) => l.type === 'chunk' && l.stream === stream).map((l) => Buffer.from(String(l.data), 'base64')),
    ).toString('utf-8');
  return { lines, stdout: bytes('stdout'), stderr: bytes('stderr'), end: lines.find((l) => l.type === 'end') };
}

describe.each([
  ['exec', {}],
  ['detached', { onPgid: () => {} }],
] as const)('defaultExecFn live output stream (%s)', (label, extra) => {
  it('streams both pipes and an end record without changing the result', async () => {
    const { cmd, streamDir } = await setup(0);
    const result = await defaultExecFn(cmd, { timeoutMs: 30_000, ...extra });
    expect(result).toEqual({ stdout: OUT, stderr: ERR });
    await vi.waitFor(() => expect(read(streamDir).end).toBeDefined(), { timeout: 5_000, interval: 20 });
    const s = read(streamDir);
    expect(s.stdout).toBe(OUT);
    expect(s.stderr).toBe(ERR);
    expect(s.lines[0]).toMatchObject({ type: 'start', shell: true, argv: [cmd] });
    expect(s.end).toMatchObject({ exitCode: 0, complete: true, bytes: { stdout: Buffer.byteLength(OUT) } });
    const chunk = s.lines.find((l) => l.type === 'chunk');
    expect(chunk?.decoded).toBe(label === 'exec' ? true : undefined);
  });

  it('records a failing exit code and still rejects', async () => {
    const { cmd, streamDir } = await setup(3);
    await expect(defaultExecFn(cmd, { timeoutMs: 30_000, ...extra })).rejects.toMatchObject({ code: 3 });
    await vi.waitFor(() => expect(read(streamDir).end).toBeDefined(), { timeout: 5_000, interval: 20 });
    expect(read(streamDir).end).toMatchObject({ exitCode: 3, timedOut: false, maxBufferExceeded: false });
  });

  it('records a maxBuffer kill', async () => {
    const { cmd, streamDir } = await setup(0);
    await expect(defaultExecFn(cmd, { timeoutMs: 30_000, maxBuffer: 1_000, ...extra })).rejects.toBeTruthy();
    await vi.waitFor(() => expect(read(streamDir).end).toBeDefined(), { timeout: 5_000, interval: 20 });
    const s = read(streamDir);
    expect(s.end).toMatchObject({ maxBufferExceeded: true, timedOut: false });
    expect(Buffer.byteLength(s.stdout)).toBeGreaterThan(1_000);
  });
});
