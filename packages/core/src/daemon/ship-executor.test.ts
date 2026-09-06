import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createShipExecutor } from './ship-executor.js';
import type { FactoryRun } from './run-runtime.js';
let dir: string;
let cliEntrypoint: string;
const run = { runId: 'run', issue: 42, repo: 'test/repo' } as FactoryRun;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ship-executor-'));
  cliEntrypoint = join(dir, 'cli.mjs');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
it('executes the installed CLI in the attached checkout and recognizes only its terminal PR result', async () => {
  await writeFile(
    cliEntrypoint,
    `console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),merge:process.env.FACTORY_MERGE,headless:process.env.FACTORY_HEADLESS})); console.log('✅ Issue #42 → PR #91 ready for review');`,
  );
  let output = '';
  const execute = createShipExecutor({ cliEntrypoint });
  const result = await execute({
    run,
    cwd: dir,
    signal: new AbortController().signal,
    output: (text) => (output += text),
  });
  expect(result).toEqual({ exitCode: 0, prUrl: 'https://github.com/test/repo/pull/91' });
  expect(JSON.parse(output.split('\n')[0])).toEqual({ args: ['ship', '42'], cwd: await realpath(dir), headless: '1' });
});
it.each([
  ['console.log("skipped already completed issue")', 0],
  ['console.log("https://github.com/test/repo/pull/91")', 0],
  ['console.log("✅ Issue #7 → PR #91 ready for review")', 0],
  ['console.log("✅ Issue #42 → PR #91 ready for review"); process.exit(1)', 1],
])(
  'does not report skipped, unrelated output, or failed execution as a successful PR: %s',
  async (script, exitCode) => {
    await writeFile(cliEntrypoint, script);
    expect(
      await createShipExecutor({ cliEntrypoint })({
        run,
        cwd: dir,
        signal: new AbortController().signal,
        output: () => {},
      }),
    ).toEqual({ exitCode, prUrl: null });
  },
);
it('bounds execution time and kills a process that ignores graceful termination', async () => {
  await writeFile(cliEntrypoint, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
  let output = '';
  const result = await createShipExecutor({ cliEntrypoint, timeoutMs: 100, terminationGraceMs: 30 })({
    run,
    cwd: dir,
    signal: new AbortController().signal,
    output: (text) => (output += text),
  });
  expect(result).toEqual({ exitCode: null, prUrl: null });
  expect(output).toContain('deadline');
});
it('cancels the process and avoids launching an already canceled request', async () => {
  await writeFile(cliEntrypoint, `console.log('ready'); setInterval(() => {}, 1000);`);
  const controller = new AbortController();
  expect(
    await createShipExecutor({ cliEntrypoint })({
      run,
      cwd: dir,
      signal: controller.signal,
      output: () => controller.abort(),
    }),
  ).toEqual({ exitCode: null, prUrl: null });
  expect(
    await createShipExecutor({ cliEntrypoint })({
      run,
      cwd: dir,
      signal: controller.signal,
      output: () => {
        throw new Error('unexpected launch');
      },
    }),
  ).toEqual({ exitCode: null, prUrl: null });
});
it('reports an unavailable checkout as a launch failure', async () => {
  await expect(
    createShipExecutor({ cliEntrypoint })({
      run,
      cwd: join(dir, 'missing'),
      signal: new AbortController().signal,
      output: () => {},
    }),
  ).rejects.toThrow();
});
it('waits for durable PID acknowledgement before the CLI can perform any work', async () => {
  await writeFile(cliEntrypoint, `console.log('✅ Issue #42 → PR #91 ready for review');`);
  let acknowledge!: () => void;
  let pid: number | undefined;
  let output = '';
  const pending = createShipExecutor({ cliEntrypoint })({
    run,
    cwd: dir,
    signal: new AbortController().signal,
    output: (text) => (output += text),
    started: async (value) => {
      pid = value;
      await new Promise<void>((resolve) => (acknowledge = resolve));
    },
  });
  await expect.poll(() => pid).toBeTypeOf('number');
  expect(output).toBe('');
  acknowledge();
  expect((await pending).prUrl).toBe('https://github.com/test/repo/pull/91');
});
