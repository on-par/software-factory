import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createRunRuntime, type RunRuntime } from './run-runtime.js';
import { writeRegistry } from './registry.js';
let dir: string;
let parent: ChildProcess | undefined;
let runtime: RunRuntime | undefined;
let detachedPid: number | undefined;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
afterEach(async () => {
  parent?.kill('SIGKILL');
  if (detachedPid) {
    try {
      process.kill(-detachedPid, 'SIGKILL');
    } catch {}
  }
  await runtime?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});
it.each(['joined', 'provider', 'checker'])(
  'kills owned process groups after daemon SIGKILL without duplicating work (detached provider=%s)',
  async (detached) => {
    parent = undefined;
    runtime = undefined;
    detachedPid = undefined;
    dir = await mkdtemp(join(tmpdir(), 'factory-crash-'));
    const registryFile = join(dir, 'registry.json');
    await writeRegistry(registryFile, {
      version: 1,
      repos: { 'test/repo': { path: dir, state: 'active', attachedAt: new Date().toISOString() } },
    });
    const cli = join(dir, 'cli.mjs');
    const marker = join(dir, 'launched');
    await writeFile(
      cli,
      `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, String(process.pid) + '\\n'); for (;;) { /* A blocked CLI cannot starve the launcher watchdog. */ }`,
    );
    const groupMarker = join(dir, 'provider-group');
    if (detached !== 'joined') {
      const commandSource = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, String(process.pid) + '\\n'); for (;;) {}`;
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(commandSource)}`;
      await writeFile(
        cli,
        `import { defaultExecFn } from ${JSON.stringify(new URL('../../dist/utils/exec.js', import.meta.url).href)}; import { writeFileSync } from 'node:fs'; await defaultExecFn(${JSON.stringify(command)}, { onPgid: pid => writeFileSync(${JSON.stringify(groupMarker)}, String(pid)), timeoutMs: 30000 });`,
      );
    }
    if (detached === 'checker') {
      const program = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, String(process.pid) + '\\n'); for (;;) {}`;
      await writeFile(
        cli,
        `import { runCommand } from ${JSON.stringify(new URL('../../dist/utils/command-runner.js', import.meta.url).href)}; import { writeFileSync } from 'node:fs'; await runCommand(${JSON.stringify([process.execPath, '-e', program])}, { onPgid: pid => writeFileSync(${JSON.stringify(groupMarker)}, String(pid)), timeoutMs: 30000 });`,
      );
    }
    const input = { runId: randomUUID(), repo: 'test/repo', issue: 1 };
    const source = `import { createRunRuntime } from ${JSON.stringify(new URL('./run-runtime.ts', import.meta.url).href)};
import { createShipExecutor } from ${JSON.stringify(new URL('./ship-executor.ts', import.meta.url).href)};
const runtime = await createRunRuntime({ registryFile: ${JSON.stringify(registryFile)}, execute: createShipExecutor({ cliEntrypoint: ${JSON.stringify(cli)} }) });
await runtime.submit(${JSON.stringify(input)}); setInterval(() => {}, 1000);`;
    parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: 'pipe' });
    let errors = '';
    parent.stderr?.on('data', (text) => (errors += String(text)));
    await expect
      .poll(
        async () => {
          try {
            return (await readFile(marker, 'utf8')).trim();
          } catch {
            return errors || '';
          }
        },
        { timeout: 10_000 },
      )
      .toMatch(/^\d+$/);
    const ownedPid = JSON.parse(await readFile(join(dir, 'runs.json'), 'utf8'))[0].executionPid as number;
    expect(alive(ownedPid)).toBe(true);
    const cliPid = Number((await readFile(marker, 'utf8')).trim());
    if (detached !== 'joined') detachedPid = Number(await readFile(groupMarker, 'utf8'));
    parent.kill('SIGKILL');
    await new Promise((resolve) => parent!.once('exit', resolve));
    runtime = await createRunRuntime({
      registryFile,
      execute: async () => {
        throw new Error('Recovery must not launch automatically');
      },
    });
    expect(runtime.get(input.runId)?.status).toBe('interrupted');
    if (alive(ownedPid))
      await expect(runtime.submit({ ...input, runId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    await expect.poll(() => alive(ownedPid) || alive(cliPid), { timeout: 10_000 }).toBe(false);
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect((await runtime.submit(input)).status).toBe('interrupted');
  },
  15_000,
);
