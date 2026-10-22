import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LaneFileGuard } from './lane-file-guard.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs.clear();
});

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lane-file-guard-holds-'));
  tempDirs.add(dir);
  return join(dir, 'lane-files.json');
}

describe('LaneFileGuard holds (#3576)', () => {
  const collision = { issue: 100, file: 'src/a.ts' };

  it('liveHold returns the hold while the holder claim still lists the file', async () => {
    const guard = new LaneFileGuard(await tmpFile());
    await guard.register('o/r', 100, ['src/a.ts']);
    await guard.recordHold('o/r', 200, collision);
    await expect(guard.liveHold('o/r', 200)).resolves.toMatchObject({ holder: 100, file: 'src/a.ts', issue: 200 });
  });

  it('liveHold returns undefined with no hold', async () => {
    const guard = new LaneFileGuard(await tmpFile());
    await expect(guard.liveHold('o/r', 200)).resolves.toBeUndefined();
  });

  it("liveHold clears and returns undefined once the holder's claim is released (#3576)", async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);
    await guard.register('o/r', 100, ['src/a.ts']);
    await guard.recordHold('o/r', 200, collision);
    await guard.release('o/r', 100);
    await expect(guard.liveHold('o/r', 200)).resolves.toBeUndefined();
    expect(await readFile(file, 'utf8')).not.toContain('o/r#200');
  });

  it('liveHold clears the hold after the holder claim is reaped', async () => {
    const guard = new LaneFileGuard(await tmpFile());
    await guard.register('o/r', 100, ['src/a.ts']);
    await guard.recordHold('o/r', 200, collision);
    await guard.sweepStale({ isStale: async () => 'issue-closed' });
    await expect(guard.liveHold('o/r', 200)).resolves.toBeUndefined();
  });

  it('liveHold clears a hold whose holder claim no longer lists the file', async () => {
    const guard = new LaneFileGuard(await tmpFile());
    await guard.register('o/r', 100, ['src/other.ts']);
    await guard.recordHold('o/r', 200, collision);
    await expect(guard.liveHold('o/r', 200)).resolves.toBeUndefined();
  });

  it("register clears the issue's own hold", async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);
    await guard.register('o/r', 100, ['src/a.ts']);
    await guard.recordHold('o/r', 200, collision);
    await guard.register('o/r', 200, ['src/b.ts']);
    expect(await readFile(file, 'utf8')).not.toContain('"holds": {\n    "o/r#200"');
    await expect(guard.liveHold('o/r', 200)).resolves.toBeUndefined();
  });

  it('releaseIssue clears holds for the issue', async () => {
    const guard = new LaneFileGuard(await tmpFile());
    await guard.register('o/r', 100, ['src/a.ts']);
    await guard.recordHold('o/r', 200, collision);
    await expect(guard.releaseIssue(200)).resolves.toBe(true);
    await expect(guard.liveHold('o/r', 200)).resolves.toBeUndefined();
  });

  it('reads claims from a pre-existing file with no holds key', async () => {
    const file = await tmpFile();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        claims: { 'o/r#100': { repo: 'o/r', issue: 100, files: ['src/a.ts'], claimedAt: 'x' } },
      }),
    );
    const guard = new LaneFileGuard(file);
    await expect(guard.findCollision('o/r', 200, ['src/a.ts'])).resolves.toEqual(collision);
    await expect(guard.liveHold('o/r', 200)).resolves.toBeUndefined();
  });
});
