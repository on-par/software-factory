import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { phaseSnapshotPorts } from './ship-phase-snapshot.js';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('phaseSnapshotPorts', () => {
  it('writes the numeric issue into issue-<n>.phase.json and annotates the last event', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ship-phase-snapshot-'));
    const ports = phaseSnapshotPorts(dir, 42);
    await ports.recordPhase('build');
    await ports.touchLastEvent('build', 'started');
    const snapshot = JSON.parse(await readFile(join(dir, 'issue-42.phase.json'), 'utf8'));
    expect(snapshot).toMatchObject({ issue: 42, phase: 'build', lastEvent: 'build: started' });
  });
});
