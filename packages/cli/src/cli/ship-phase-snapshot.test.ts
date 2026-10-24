import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { phaseSnapshotPorts } from './ship-phase-snapshot.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

describe('phaseSnapshotPorts', () => {
  it('writes the numeric issue into issue-<n>.phase.json and annotates the last event', async () => {
    const dir = await tmp.make('ship-phase-snapshot-');
    const ports = phaseSnapshotPorts(dir, 42);
    await ports.recordPhase('build');
    await ports.touchLastEvent('build', 'started');
    const snapshot = JSON.parse(await readFile(join(dir, 'issue-42.phase.json'), 'utf8'));
    expect(snapshot).toMatchObject({ issue: 42, phase: 'build', lastEvent: 'build: started' });
  });
});
