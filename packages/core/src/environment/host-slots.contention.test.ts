import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
});
