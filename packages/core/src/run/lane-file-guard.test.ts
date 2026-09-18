import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DesignArtifact } from '../types/index.js';
import { LaneFileGuard, touchedFilesFrom } from './lane-file-guard.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs.clear();
});

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lane-file-guard-test-'));
  tempDirs.add(dir);
  return join(dir, 'lane-files.json');
}

function baseDesign(overrides: Partial<Pick<DesignArtifact, 'targetTypes' | 'signatures'>> = {}) {
  return {
    targetTypes: [],
    signatures: [],
    ...overrides,
  };
}

describe('touchedFilesFrom', () => {
  it('dedups repeated files across targetTypes and signatures', () => {
    const files = touchedFilesFrom(
      baseDesign({
        targetTypes: [{ name: 'Foo', file: 'src/a.ts', kind: 'changed' }],
        signatures: [{ symbol: 'foo', file: 'src/a.ts', signature: '() => void' }],
      }),
    );
    expect(files).toEqual(['src/a.ts']);
  });

  it('excludes a targetTypes entry with kind: read', () => {
    const files = touchedFilesFrom(
      baseDesign({
        targetTypes: [{ name: 'Foo', file: 'src/read-only.ts', kind: 'read' }],
      }),
    );
    expect(files).toEqual([]);
  });

  it('includes targetTypes entries with kind changed or added', () => {
    const files = touchedFilesFrom(
      baseDesign({
        targetTypes: [
          { name: 'Foo', file: 'src/changed.ts', kind: 'changed' },
          { name: 'Bar', file: 'src/added.ts', kind: 'added' },
        ],
      }),
    );
    expect(files.sort()).toEqual(['src/added.ts', 'src/changed.ts']);
  });

  it('includes every signatures entry regardless of kind (signatures has no kind field)', () => {
    const files = touchedFilesFrom(
      baseDesign({
        signatures: [{ symbol: 'foo', file: 'src/sig.ts', signature: '() => void' }],
      }),
    );
    expect(files).toEqual(['src/sig.ts']);
  });
});

describe('LaneFileGuard', () => {
  it('findCollision returns the colliding issue+file when another repo-scoped claim overlaps', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);

    await guard.register('acme/repo', 100, ['src/shared.ts']);
    const collision = await guard.findCollision('acme/repo', 200, ['src/shared.ts', 'src/other.ts']);

    expect(collision).toEqual({ issue: 100, file: 'src/shared.ts' });
  });

  it('findCollision returns undefined for a disjoint file set', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);

    await guard.register('acme/repo', 100, ['src/shared.ts']);
    const collision = await guard.findCollision('acme/repo', 200, ['src/unrelated.ts']);

    expect(collision).toBeUndefined();
  });

  it('findCollision excludes the same repo+issue that registered the claim', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);

    await guard.register('acme/repo', 100, ['src/shared.ts']);
    const collision = await guard.findCollision('acme/repo', 100, ['src/shared.ts']);

    expect(collision).toBeUndefined();
  });

  it('findCollision is scoped to a single repo — an overlapping file in a different repo does not collide', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);

    await guard.register('acme/repo-a', 100, ['src/shared.ts']);
    const collision = await guard.findCollision('acme/repo-b', 200, ['src/shared.ts']);

    expect(collision).toBeUndefined();
  });

  it('register is a no-op for an empty file set', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);

    await guard.register('acme/repo', 100, []);
    const collision = await guard.findCollision('acme/repo', 200, []);

    expect(collision).toBeUndefined();
  });

  it('release makes a previously-claimed path claimable again', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);

    await guard.register('acme/repo', 100, ['src/shared.ts']);
    await guard.release('acme/repo', 100);
    const collision = await guard.findCollision('acme/repo', 200, ['src/shared.ts']);

    expect(collision).toBeUndefined();
  });

  it('release on a repo+issue with no claim is a no-op that does not throw', async () => {
    const file = await tmpFile();
    const guard = new LaneFileGuard(file);

    await expect(guard.release('acme/repo', 999)).resolves.toBeUndefined();
  });
});
