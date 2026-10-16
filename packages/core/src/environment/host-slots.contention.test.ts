import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { hostBuildSlotsDir } from './host-slots.js';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

function runChild(childPath: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', childPath, ...args], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

describe('host build slots across processes', () => {
  it(
    'three processes against a temp home never hold more than two slots and the third logs waiting for host build slot (2/2 in use)',
    { timeout: 60_000 },
    async () => {
      const tmpHome = await mkdtemp(join(tmpdir(), 'factory-host-slots-contention-'));
      try {
        const eventsFile = join(tmpHome, 'events.txt');
        const childPath = join(tmpHome, 'child.mts');
        const spec = pathToFileURL(join(repoRoot, 'packages/core/src/environment/host-slots.ts')).href;
        await writeFile(
          childPath,
          `import { appendFileSync } from 'node:fs';
import { hostBuildSlotsDir, withHostBuildSlot } from '${spec}';
const [home, repo, issue, eventsFile] = process.argv.slice(2);
await withHostBuildSlot(
  { dir: hostBuildSlotsDir(home), maxBuilds: 2, repo, issue: Number(issue), phase: 'build', pollMs: 25,
    log: (m) => process.stdout.write(m + '\\n') },
  async () => {
    appendFileSync(eventsFile, 'start ' + issue + ' ' + Date.now() + '\\n');
    await new Promise((r) => setTimeout(r, 400));
    appendFileSync(eventsFile, 'end ' + issue + ' ' + Date.now() + '\\n');
  },
);
`,
        );
        const results = await Promise.all(
          ['1', '2', '3'].map((issue) => runChild(childPath, [tmpHome, `o/r${issue}`, issue, eventsFile])),
        );
        for (const r of results) expect(r, r.stderr).toMatchObject({ code: 0 });

        const events = (await readFile(eventsFile, 'utf8'))
          .trim()
          .split('\n')
          .map((l) => {
            const [kind, , ts] = l.split(' ');
            return { kind, ts: Number(ts) };
          })
          // ends sort before starts at equal timestamps: a released slot may be retaken instantly
          .sort((a, b) => a.ts - b.ts || (a.kind === 'end' ? -1 : 1));
        let active = 0;
        let peak = 0;
        for (const e of events) {
          active += e.kind === 'start' ? 1 : -1;
          peak = Math.max(peak, active);
        }
        expect(events).toHaveLength(6);
        expect(peak).toBe(2);
        expect(results.some((r) => r.stdout.includes('waiting for host build slot (2/2 in use)'))).toBe(true);
        const left = (await readdir(hostBuildSlotsDir(tmpHome))).filter((f) => f.startsWith('slot-'));
        expect(left).toEqual([]);
      } finally {
        await rm(tmpHome, { recursive: true, force: true });
      }
    },
  );

  it(
    "a holder killed with SIGKILL leaves a slot that another process reclaims and logs reclaimed host build slot 0 with the dead holder's repo, issue and pid",
    { timeout: 60_000 },
    async () => {
      const tmpHome = await mkdtemp(join(tmpdir(), 'factory-host-slots-kill-'));
      try {
        const spec = pathToFileURL(join(repoRoot, 'packages/core/src/environment/host-slots.ts')).href;
        const holderPath = join(tmpHome, 'holder.mts');
        await writeFile(
          holderPath,
          `import { acquireHostBuildSlot, hostBuildSlotsDir } from '${spec}';
await acquireHostBuildSlot({ dir: hostBuildSlotsDir(process.argv[2]), maxBuilds: 1, repo: 'o/dead', issue: 41, phase: 'build' });
process.stdout.write('held ' + process.pid + '\\n');
setInterval(() => {}, 1000);
await new Promise(() => {});
`,
        );
        const waiterPath = join(tmpHome, 'waiter.mts');
        await writeFile(
          waiterPath,
          `import { hostBuildSlotsDir, withHostBuildSlot } from '${spec}';
await withHostBuildSlot(
  { dir: hostBuildSlotsDir(process.argv[2]), maxBuilds: 1, repo: 'o/live', issue: 42, phase: 'build', pollMs: 25,
    log: (m) => process.stdout.write(m + '\\n') },
  async () => {},
);
`,
        );
        const holder = spawn(process.execPath, ['--import', 'tsx', holderPath, tmpHome], {
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const holderPid = await new Promise<number>((resolvePromise, reject) => {
          let out = '';
          holder.stdout.on('data', (c) => {
            out += c.toString();
            const m = /held (\d+)/.exec(out);
            if (m) resolvePromise(Number(m[1]));
          });
          holder.on('error', reject);
          holder.on('close', () => reject(new Error('holder exited early')));
        });
        const closed = new Promise<void>((r) => holder.on('close', () => r()));
        holder.kill('SIGKILL');
        await closed;
        const slot = JSON.parse(await readFile(join(hostBuildSlotsDir(tmpHome), 'slot-0.json'), 'utf8'));
        expect(slot.pid).toBe(holderPid);

        const r = await runChild(waiterPath, [tmpHome]);
        expect(r, r.stderr).toMatchObject({ code: 0 });
        expect(r.stdout).toContain(`reclaimed host build slot 0 from o/dead#41 (pid ${holderPid}, not alive)`);
        const left = (await readdir(hostBuildSlotsDir(tmpHome))).filter((f) => f.startsWith('slot-'));
        expect(left).toEqual([]);
      } finally {
        await rm(tmpHome, { recursive: true, force: true });
      }
    },
  );

  it(
    'two processes racing to reclaim one stale slot with maxBuilds 1 log exactly one reclaim and never overlap',
    { timeout: 60_000 },
    async () => {
      const tmpHome = await mkdtemp(join(tmpdir(), 'factory-host-slots-race-'));
      try {
        const eventsFile = join(tmpHome, 'events.txt');
        const childPath = join(tmpHome, 'child.mts');
        const spec = pathToFileURL(join(repoRoot, 'packages/core/src/environment/host-slots.ts')).href;
        const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
        const dir = hostBuildSlotsDir(tmpHome);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, 'slot-0.json'),
          JSON.stringify({ pid: deadPid, repo: 'o/dead', issue: 9, phase: 'build', token: 'stale', acquiredAt: '' }),
        );
        await writeFile(
          childPath,
          `import { appendFileSync } from 'node:fs';
import { hostBuildSlotsDir, withHostBuildSlot } from '${spec}';
const [home, issue, eventsFile] = process.argv.slice(2);
await withHostBuildSlot(
  { dir: hostBuildSlotsDir(home), maxBuilds: 1, repo: 'o/r', issue: Number(issue), phase: 'build', pollMs: 25,
    log: (m) => process.stdout.write(m + '\\n') },
  async () => {
    appendFileSync(eventsFile, 'start ' + issue + ' ' + Date.now() + '\\n');
    await new Promise((r) => setTimeout(r, 300));
    appendFileSync(eventsFile, 'end ' + issue + ' ' + Date.now() + '\\n');
  },
);
`,
        );
        const results = await Promise.all(['1', '2'].map((issue) => runChild(childPath, [tmpHome, issue, eventsFile])));
        for (const r of results) expect(r, r.stderr).toMatchObject({ code: 0 });
        const events = (await readFile(eventsFile, 'utf8'))
          .trim()
          .split('\n')
          .map((l) => {
            const [kind, , ts] = l.split(' ');
            return { kind, ts: Number(ts) };
          })
          .sort((a, b) => a.ts - b.ts || (a.kind === 'end' ? -1 : 1));
        let active = 0;
        let peak = 0;
        for (const e of events) {
          active += e.kind === 'start' ? 1 : -1;
          peak = Math.max(peak, active);
        }
        expect(events).toHaveLength(4);
        expect(peak).toBe(1);
        const reclaims = results
          .flatMap((r) => r.stdout.split('\n'))
          .filter((l) => l.includes('reclaimed host build slot 0'));
        expect(reclaims).toHaveLength(1);
      } finally {
        await rm(tmpHome, { recursive: true, force: true });
      }
    },
  );
});
