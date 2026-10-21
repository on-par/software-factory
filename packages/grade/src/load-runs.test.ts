import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readIssueRunState } from '@on-par/factory-core/internal';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadRuns } from './load-runs.js';

const fixtureRuns = fileURLToPath(new URL('./__fixtures__/three-runs/state/runs', import.meta.url));
const tmpDirs: string[] = [];

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'grade-runs-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadRuns', () => {
  it('returns all 3 fixture runs read through the core run store without writing anything', async () => {
    const dir = await tmp();
    await cp(fixtureRuns, dir, { recursive: true });
    const before = await readdir(dir, { recursive: true });
    const readRun = vi.fn(readIssueRunState);

    const { runs, skipped } = await loadRuns(dir, { readRun });

    expect(runs.map((r) => r.issue)).toEqual([101, 102, 103]);
    expect(skipped).toEqual([]);
    expect(readRun).toHaveBeenCalledTimes(3);
    expect(readRun.mock.calls.map(([file]) => file)).toEqual([
      join(dir, 'issue-101.json'),
      join(dir, 'issue-102.json'),
      join(dir, 'issue-103.json'),
    ]);
    expect(await readdir(dir, { recursive: true })).toEqual(before);

    const direct = await loadRuns(fixtureRuns);
    expect(direct.runs.map((r) => r.issue)).toEqual([101, 102, 103]);
  });

  it('returns only runs started on or after since', async () => {
    const { runs } = await loadRuns(fixtureRuns, { since: new Date('2026-10-05') });
    expect(runs.map((r) => r.issue)).toEqual([102, 103]);
    expect((await loadRuns(fixtureRuns, { since: new Date('2027-01-01') })).runs).toEqual([]);
    await expect(loadRuns(fixtureRuns, { since: new Date('nope') })).rejects.toBeInstanceOf(RangeError);
  });

  it('returns an empty result for a missing directory', async () => {
    const dir = await tmp();
    expect(await loadRuns(join(dir, 'absent'))).toEqual({ runs: [], skipped: [] });
  });

  it('names unreadable run files in skipped', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'issue-9.json'), '{not json');
    await writeFile(join(dir, 'issue-8.json'), JSON.stringify({ issue: 8 }));
    await writeFile(join(dir, 'issue-7.json.tmp'), 'x');
    const { runs, skipped } = await loadRuns(dir);
    expect(runs).toEqual([]);
    expect(skipped).toEqual(['issue-8.json', 'issue-9.json']);
  });

  it('keeps an unparsable startedAt without since and drops it with since, ties sort by issue', async () => {
    const dir = await tmp();
    const run = (issue: number, startedAt: string): string => JSON.stringify({ issue, startedAt });
    await writeFile(join(dir, 'issue-5.json'), run(5, 'garbage'));
    await writeFile(join(dir, 'issue-4.json'), run(4, '2026-10-05T00:00:00.000Z'));
    await writeFile(join(dir, 'issue-3.json'), run(3, '2026-10-05T00:00:00.000Z'));
    await writeFile(join(dir, 'issue-6.json'), run(6, '2026-10-06T00:00:00.000Z'));
    expect((await loadRuns(dir)).runs.map((r) => r.issue)).toEqual([5, 3, 4, 6]);
    expect((await loadRuns(dir, { since: new Date('2026-10-01') })).runs.map((r) => r.issue)).toEqual([3, 4, 6]);
  });

  it('rethrows readdir errors other than ENOENT', async () => {
    const dir = await tmp();
    const file = join(dir, 'not-a-dir');
    await mkdir(dir, { recursive: true });
    await writeFile(file, 'x');
    await expect(loadRuns(file)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
