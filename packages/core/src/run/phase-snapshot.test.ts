import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RunPhaseSnapshot } from './phase-snapshot.js';
import { phaseSnapshotFile, readPhaseSnapshot, touchRunActivity, writePhaseSnapshot } from './phase-snapshot.js';

describe('run/phase-snapshot', () => {
  describe('phaseSnapshotFile', () => {
    it('names the file issue-<n>.phase.json inside runsDir', () => {
      expect(phaseSnapshotFile('/tmp/runs', 1325)).toBe('/tmp/runs/issue-1325.phase.json');
    });
  });

  describe('writePhaseSnapshot', () => {
    it('writes the record atomically into a not-yet-created directory', async () => {
      const runsDir = join(mkdtempSync(join(tmpdir(), 'phase-snapshot-runs-')), 'nested', 'runs');
      const file = phaseSnapshotFile(runsDir, 1325);
      const snapshot: RunPhaseSnapshot = {
        issue: 1325,
        phase: 'check',
        updatedAt: '2026-09-08T00:00:00.000Z',
        lastActivityAt: '2026-09-08T00:00:00.000Z',
      };

      await writePhaseSnapshot(file, snapshot);

      const persisted = JSON.parse(readFileSync(file, 'utf-8')) as RunPhaseSnapshot;
      expect(persisted).toEqual(snapshot);
    });

    it('overwrites a prior snapshot for the same issue', async () => {
      const runsDir = mkdtempSync(join(tmpdir(), 'phase-snapshot-runs-'));
      const file = phaseSnapshotFile(runsDir, 1325);

      await writePhaseSnapshot(file, {
        issue: 1325,
        phase: 'plan',
        updatedAt: '2026-09-08T00:00:00.000Z',
        lastActivityAt: '2026-09-08T00:00:00.000Z',
      });
      await writePhaseSnapshot(file, {
        issue: 1325,
        phase: 'build',
        updatedAt: '2026-09-08T00:01:00.000Z',
        lastActivityAt: '2026-09-08T00:01:00.000Z',
      });

      const persisted = JSON.parse(readFileSync(file, 'utf-8')) as RunPhaseSnapshot;
      expect(persisted.phase).toBe('build');
    });
  });

  describe('readPhaseSnapshot', () => {
    it('round-trips a written record', async () => {
      const runsDir = mkdtempSync(join(tmpdir(), 'phase-snapshot-runs-'));
      const file = phaseSnapshotFile(runsDir, 1325);
      const snapshot: RunPhaseSnapshot = {
        issue: 1325,
        phase: 'ship',
        updatedAt: '2026-09-08T00:02:00.000Z',
        lastActivityAt: '2026-09-08T00:02:00.000Z',
      };
      await writePhaseSnapshot(file, snapshot);

      const read = await readPhaseSnapshot(file);

      expect(read).toEqual(snapshot);
    });

    it('returns null for a missing file, malformed JSON, and array JSON, never throwing', async () => {
      const runsDir = mkdtempSync(join(tmpdir(), 'phase-snapshot-runs-'));

      await expect(readPhaseSnapshot(join(runsDir, 'missing.json'))).resolves.toBeNull();

      const badJsonFile = join(runsDir, 'bad.json');
      writeFileSync(badJsonFile, 'not json');
      await expect(readPhaseSnapshot(badJsonFile)).resolves.toBeNull();

      const arrayJsonFile = join(runsDir, 'array.json');
      writeFileSync(arrayJsonFile, '[]');
      await expect(readPhaseSnapshot(arrayJsonFile)).resolves.toBeNull();
    });

    it('returns null when phase is not a valid FailurePhase', async () => {
      const runsDir = mkdtempSync(join(tmpdir(), 'phase-snapshot-runs-'));
      const file = join(runsDir, 'issue-1.phase.json');
      writeFileSync(
        file,
        JSON.stringify({
          issue: 1,
          phase: 'building',
          updatedAt: '2026-09-08T00:00:00.000Z',
          lastActivityAt: '2026-09-08T00:00:00.000Z',
        }),
      );

      await expect(readPhaseSnapshot(file)).resolves.toBeNull();
    });

    it('returns null when lastActivityAt is missing (pre-#1326 snapshot)', async () => {
      const runsDir = mkdtempSync(join(tmpdir(), 'phase-snapshot-runs-'));
      const file = join(runsDir, 'issue-1.phase.json');
      writeFileSync(file, JSON.stringify({ issue: 1, phase: 'check', updatedAt: '2026-09-08T00:00:00.000Z' }));

      await expect(readPhaseSnapshot(file)).resolves.toBeNull();
    });
  });

  describe('touchRunActivity', () => {
    it('bumps lastActivityAt while leaving phase and updatedAt untouched', async () => {
      const runsDir = mkdtempSync(join(tmpdir(), 'phase-snapshot-runs-'));
      const file = phaseSnapshotFile(runsDir, 1326);
      await writePhaseSnapshot(file, {
        issue: 1326,
        phase: 'check',
        updatedAt: '2026-09-08T00:00:00.000Z',
        lastActivityAt: '2026-09-08T00:00:00.000Z',
      });

      await touchRunActivity(file, '2026-09-08T00:05:00.000Z');

      const persisted = JSON.parse(readFileSync(file, 'utf-8')) as RunPhaseSnapshot;
      expect(persisted).toEqual({
        issue: 1326,
        phase: 'check',
        updatedAt: '2026-09-08T00:00:00.000Z',
        lastActivityAt: '2026-09-08T00:05:00.000Z',
      });
    });

    it('is a no-op when no snapshot exists yet', async () => {
      const runsDir = mkdtempSync(join(tmpdir(), 'phase-snapshot-runs-'));
      const file = phaseSnapshotFile(runsDir, 1326);

      await expect(touchRunActivity(file, '2026-09-08T00:05:00.000Z')).resolves.toBeUndefined();
      await expect(readPhaseSnapshot(file)).resolves.toBeNull();
    });
  });
});
