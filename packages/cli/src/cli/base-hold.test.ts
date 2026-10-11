import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type BaseHold, deleteBaseHold, readBaseHold, writeBaseHold } from './base-hold.js';

const hold: BaseHold = {
  repo: 'on-par/software-factory',
  baseSha: 'abc1234567890def',
  failingChecks: ['tests', 'lint'],
  since: '2026-01-01T00:00:00.000Z',
};

describe('base-hold', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factory-base-hold-'));
    file = join(dir, 'state', 'base-hold.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the hold under a missing state dir', () => {
    writeBaseHold(file, hold);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual(hold);
  });

  it('reads back exactly the record that was written', () => {
    writeBaseHold(file, hold);
    const read = readBaseHold(file);
    expect(read).toEqual(hold);
    expect(read?.failingChecks).not.toBe(hold.failingChecks);
  });

  it('drops unknown keys', async () => {
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(file, JSON.stringify({ ...hold, extra: 1 }));
    expect(readBaseHold(file)).toEqual(hold);
  });

  it.each([
    ['missing file', undefined],
    ['non-JSON', 'not json'],
    ['null', 'null'],
    ['array', '[]'],
    ['number', '42'],
    ['empty object', '{}'],
    ['repo not a string', JSON.stringify({ ...hold, repo: 1 })],
    ['baseSha not a string', JSON.stringify({ ...hold, baseSha: 1 })],
    ['since not a string', JSON.stringify({ ...hold, since: 1 })],
    ['failingChecks not an array', JSON.stringify({ ...hold, failingChecks: 'tests' })],
    ['failingChecks containing a number', JSON.stringify({ ...hold, failingChecks: ['tests', 1] })],
  ])('treats a missing or malformed file as no hold (%s)', async (_name, content) => {
    if (content !== undefined) {
      await mkdir(join(dir, 'state'), { recursive: true });
      await writeFile(file, content);
    }
    expect(() => readBaseHold(file)).not.toThrow();
    expect(readBaseHold(file)).toBeNull();
  });

  it('deletes the hold, and deleting an absent hold is a no-op', () => {
    writeBaseHold(file, hold);
    deleteBaseHold(file);
    expect(existsSync(file)).toBe(false);
    expect(readBaseHold(file)).toBeNull();
    expect(() => deleteBaseHold(file)).not.toThrow();
  });
});
