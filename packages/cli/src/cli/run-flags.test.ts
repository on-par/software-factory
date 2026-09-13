import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readRunFlagOverrides, writeRunFlagOverrides } from './run-flags.js';

describe('run-flags', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-flags-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('auto-merge flag: round-trips true and false through the run-flags file', () => {
    const file = join(dir, 'run-flags.json');

    writeRunFlagOverrides(file, { autoMerge: true });
    expect(readRunFlagOverrides(file)).toEqual({ autoMerge: true });

    writeRunFlagOverrides(file, { autoMerge: false });
    expect(readRunFlagOverrides(file)).toEqual({ autoMerge: false });
  });

  it('auto-merge flag: writing an empty override set removes a stale run-flags file', () => {
    const file = join(dir, 'run-flags.json');

    writeRunFlagOverrides(file, { autoMerge: true });
    expect(existsSync(file)).toBe(true);

    writeRunFlagOverrides(file, {});
    expect(existsSync(file)).toBe(false);
    expect(readRunFlagOverrides(file)).toEqual({});
  });

  it('auto-merge flag: writing to a missing directory creates it', () => {
    const file = join(dir, 'nested', 'deeper', 'run-flags.json');

    writeRunFlagOverrides(file, { autoMerge: true });

    expect(existsSync(file)).toBe(true);
    expect(readRunFlagOverrides(file)).toEqual({ autoMerge: true });
  });

  it('auto-merge flag: reads a missing, malformed, array, or non-boolean run-flags file as no override', () => {
    const missing = join(dir, 'missing.json');
    expect(readRunFlagOverrides(missing)).toEqual({});

    const malformed = join(dir, 'malformed.json');
    writeFileSync(malformed, 'not json');
    expect(readRunFlagOverrides(malformed)).toEqual({});

    const array = join(dir, 'array.json');
    writeFileSync(array, '[1,2]');
    expect(readRunFlagOverrides(array)).toEqual({});

    const wrongType = join(dir, 'wrong-type.json');
    writeFileSync(wrongType, JSON.stringify({ autoMerge: 'yes' }));
    expect(readRunFlagOverrides(wrongType)).toEqual({});
  });
});
