import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listIssueRuns, readIssueRunState } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadRuns } from './load-runs.js';

const fixtureRuns = fileURLToPath(new URL('./__fixtures__/three-runs/state/runs', import.meta.url));
const tempDirs = createTempDirs();

function tmp(): Promise<string> {
  return tempDirs.make('grade-runs-');
}

afterEach(async () => {
  await tempDirs.cleanup();
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
    const run = (issue: number, startedAt: string): string =>
      JSON.stringify({ issue, startedAt, updatedAt: startedAt });
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

  it('counts the same runs as listIssueRuns on the shared fixture', async () => {
    const dir = await tmp();
    await cp(fixtureRuns, dir, { recursive: true });
    const base = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'issue-101.json'), 'utf-8'));
    const { updatedAt: _dropped, ...noUpdatedAt } = { ...base, issue: 104 };
    await writeFile(join(dir, 'issue-104.json'), JSON.stringify(noUpdatedAt));

    const loaded = await loadRuns(dir);
    const listed = await listIssueRuns(dir);

    expect(new Set(loaded.runs.map((r) => r.issue))).toEqual(new Set(listed.runs.map((r) => r.issue)));
    expect(loaded.skipped).toEqual(listed.skipped);
    expect(loaded.skipped).toEqual(['issue-104.json']);
  });
});
