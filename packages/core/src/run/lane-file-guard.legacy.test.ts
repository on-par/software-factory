import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { workKeyFromIssue } from '../work/work-key.js';
import { LaneFileGuard } from './lane-file-guard.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs.clear();
});

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lane-file-guard-legacy-'));
  tempDirs.add(dir);
  return join(dir, 'lane-files.json');
}

describe('LaneFileGuard legacy lane-files.json', () => {
  it('matches a legacy numeric claim in lane-files.json by WorkKey', async () => {
    const file = await tmpFile();
    const claimedAt = '2026-01-01T00:00:00.000Z';
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        claims: { 'o/r#7': { repo: 'o/r', issue: 7, files: ['a.ts'], claimedAt } },
        holds: { 'o/r#8': { repo: 'o/r', issue: 8, holder: 7, file: 'a.ts', heldAt: claimedAt } },
      }),
    );
    const guard = new LaneFileGuard(file);
    const K7 = workKeyFromIssue(7);
    const K8 = workKeyFromIssue(8);

    expect(await guard.claimsForIssue(K7)).toHaveLength(1);
    expect(await guard.findCollision('o/r', K7, ['a.ts'])).toBeUndefined();
    expect(await guard.findCollision('o/r', K8, ['a.ts'])).toEqual({ issue: '7', file: 'a.ts' });
    expect(await guard.liveHold('o/r', K8)).toBeDefined();
    expect(await guard.releaseIssue(K7)).toBe(true);
  });
});
