import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readFlakyLedger, recordFlakes, setFlakyIssue } from './flaky-ledger.js';

describe('flaky-ledger', () => {
  let dir: string;
  let file: string;
  const now = () => new Date('2026-02-03T04:05:06.000Z');
  const ISO = '2026-02-03T04:05:06.000Z';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factory-flaky-'));
    file = join(dir, 'state', 'flaky-tests.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const raw = async () => JSON.parse(await readFile(file, 'utf-8'));
  const putRaw = async (value: string) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, value);
  };

  it('creates the file on first record', async () => {
    expect(await recordFlakes(file, '1@abcdef12', ['t'], now)).toEqual([]);
    expect(await raw()).toEqual({ t: { runs: ['1@abcdef12'], lastSeen: ISO, issue: null } });
  });

  it('dedupes runs and test names', async () => {
    await recordFlakes(file, '1@a', ['t', 't'], now);
    await recordFlakes(file, '1@a', ['t'], now);
    expect((await raw()).t.runs).toEqual(['1@a']);
  });

  it('returns entries at 3 distinct runs and onward, only for touched tests at threshold', async () => {
    await recordFlakes(file, '1@a', ['t'], now);
    await recordFlakes(file, '2@a', ['t'], now);
    expect(await recordFlakes(file, '3@a', ['t', 'other'], now)).toEqual([
      { test: 't', runs: ['1@a', '2@a', '3@a'], lastSeen: ISO, issue: null },
    ]);
    const fourth = await recordFlakes(file, '4@a', ['t'], now);
    expect(fourth[0]?.runs).toHaveLength(4);
  });

  it('uses the real clock by default', async () => {
    await recordFlakes(file, '1@a', ['t']);
    expect(Number.isNaN(Date.parse((await raw()).t.lastSeen))).toBe(false);
  });

  it('empty tests returns [] and creates nothing', async () => {
    expect(await recordFlakes(file, '1@a', [], now)).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it('setFlakyIssue stores the number', async () => {
    await recordFlakes(file, '1@a', ['t'], now);
    await setFlakyIssue(file, 't', 42);
    await recordFlakes(file, '2@a', ['t'], now);
    expect((await recordFlakes(file, '3@a', ['t'], now))[0]?.issue).toBe(42);
  });

  it('setFlakyIssue for an unknown test changes nothing', async () => {
    await setFlakyIssue(file, 'x', 1);
    expect(existsSync(file)).toBe(false);
    await recordFlakes(file, '1@a', ['t'], now);
    const before = await readFile(file, 'utf-8');
    await setFlakyIssue(file, 'x', 1);
    expect(await readFile(file, 'utf-8')).toBe(before);
  });

  it('reads malformed files as empty', async () => {
    expect(await readFlakyLedger(file)).toEqual({});
    for (const text of ['not json', 'null', '[]', '5']) {
      await putRaw(text);
      expect(await readFlakyLedger(file)).toEqual({});
    }
  });

  it('drops malformed entries and defaults a missing issue', async () => {
    await putRaw(
      JSON.stringify({
        ok: { runs: ['1@a'], lastSeen: ISO },
        notObject: 5,
        badRuns: { runs: 'x', lastSeen: ISO, issue: null },
        badRun: { runs: [1], lastSeen: ISO, issue: null },
        badSeen: { runs: [], lastSeen: 3, issue: null },
        badIssue: { runs: [], lastSeen: ISO, issue: '7' },
      }),
    );
    expect(await readFlakyLedger(file)).toEqual({ ok: { runs: ['1@a'], lastSeen: ISO, issue: null } });
  });

  it('leaves no tmp file behind', async () => {
    await recordFlakes(file, '1@a', ['t'], now);
    expect((await readdir(dirname(file))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
