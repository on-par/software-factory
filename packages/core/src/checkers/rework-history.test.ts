import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ReworkHistory } from './rework-history.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs.clear();
});

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rework-history-test-'));
  tempDirs.add(dir);
  return join(dir, 'rework-history.json');
}

describe('ReworkHistory', () => {
  it('returns undefined for an issue with no recorded signature', async () => {
    const history = new ReworkHistory(await tmpFile());
    expect(await history.priorSignature(640)).toBeUndefined();
  });

  it('records a signature and returns it from a fresh instance reading the same file', async () => {
    const file = await tmpFile();
    await new ReworkHistory(file).record(640, 'tests:something-failed', ['tests', 'design_smells']);

    const reopened = new ReworkHistory(file);
    expect(await reopened.priorSignature(640)).toBe('tests:something-failed');
  });

  it('refreshes recordedAt and signature on a repeat record for the same issue', async () => {
    const file = await tmpFile();
    let t = 1_000;
    const history = new ReworkHistory(file, () => t);

    await history.record(640, 'sig-a', ['tests']);
    t = 2_000;
    await history.record(640, 'sig-b', ['lint']);

    const raw = JSON.parse(await readFile(file, 'utf-8'));
    expect(raw.issues['640']).toEqual({
      signature: 'sig-b',
      failingChecks: ['lint'],
      recordedAt: new Date(2_000).toISOString(),
    });
  });

  it('keeps separate issues independent', async () => {
    const file = await tmpFile();
    const history = new ReworkHistory(file);

    await history.record(640, 'sig-640', ['tests']);
    await history.record(715, 'sig-715', ['lint']);

    expect(await history.priorSignature(640)).toBe('sig-640');
    expect(await history.priorSignature(715)).toBe('sig-715');
  });

  it('clear removes the entry so priorSignature goes back to undefined', async () => {
    const file = await tmpFile();
    const history = new ReworkHistory(file);

    await history.record(640, 'sig-a', ['tests']);
    await history.clear(640);

    expect(await history.priorSignature(640)).toBeUndefined();
  });

  it('clear on an issue with no entry is a harmless no-op', async () => {
    const file = await tmpFile();
    const history = new ReworkHistory(file);
    await expect(history.clear(999)).resolves.toBeUndefined();
  });

  it('treats a missing file the same as an empty history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rework-history-test-'));
    tempDirs.add(dir);
    const history = new ReworkHistory(join(dir, 'does-not-exist.json'));
    expect(await history.priorSignature(1)).toBeUndefined();
  });

  it('treats a corrupt file the same as an empty history rather than throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rework-history-test-'));
    tempDirs.add(dir);
    const file = join(dir, 'rework-history.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, 'not json');

    const history = new ReworkHistory(file);
    expect(await history.priorSignature(1)).toBeUndefined();
    // Recording after a corrupt read should heal the file, not propagate the corruption.
    await history.record(1, 'sig', ['tests']);
    expect(await history.priorSignature(1)).toBe('sig');
  });
});
