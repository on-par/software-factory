import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentMemoryChecks } from './doctor-agent-memory.js';

const tmp = createTempDirs();
const repo = (): Promise<string> => tmp.make('doctor-agent-memory-');

afterEach(async () => {
  vi.unstubAllEnvs();
  await tmp.cleanup();
});

describe('agentMemoryChecks', () => {
  it('returns nothing when the directory is missing', async () => {
    expect(await agentMemoryChecks(await repo())).toEqual([]);
  });

  it('returns nothing when every file fits the cap', async () => {
    const root = await repo();
    await mkdir(join(root, '.factory/agent-memory'), { recursive: true });
    await writeFile(join(root, '.factory/agent-memory/alpha.md'), 'small');
    expect(await agentMemoryChecks(root)).toEqual([]);
  });

  it('agentMemoryChecks warns (optional, non-failing) for a memory file over the cap', async () => {
    const root = await repo();
    await mkdir(join(root, '.factory/agent-memory'), { recursive: true });
    await writeFile(join(root, '.factory/agent-memory/alpha.md'), 'x'.repeat(4097));
    const rows = await agentMemoryChecks(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: false, optional: true });
    expect(rows[0]?.detail).toContain('.factory/agent-memory/alpha.md');
    expect(rows[0]?.fix).toContain('pull request');
  });

  it.each([
    { name: 'external', external: true, file: (dir: string) => join(dir, 'agent-memory', 'alpha.md') },
    { name: 'unset', external: false, file: () => '.factory/agent-memory/alpha.md' },
  ])('scans agent-memory through the project config directory ($name) (#4340)', async ({ external, file }) => {
    const root = await repo();
    const dir = await tmp.make('doctor-agent-memory-external-');
    await mkdir(join(root, '.factory/agent-memory'), { recursive: true });
    await writeFile(join(root, '.factory/agent-memory/alpha.md'), 'x'.repeat(4097));
    await mkdir(join(dir, 'agent-memory'));
    await writeFile(join(dir, 'agent-memory/alpha.md'), 'x'.repeat(5000));
    if (external) vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR', dir);

    const rows = await agentMemoryChecks(root);

    expect(rows.map((r) => r.detail)).toEqual([
      `${file(dir)} is ${external ? 5000 : 4097} bytes, over the 4096-byte cap; ${external ? 'the run fails before PLAN' : 'PLAN ignores it'}`,
    ]);
  });
});
