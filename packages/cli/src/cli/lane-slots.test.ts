// packages/cli/src/cli/lane-slots.test.ts — lane slot state, status section and --max-lanes parsing (#3958).

import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliExitError } from './errors.js';
import {
  clearLaneSlots,
  formatLaneSlotsSection,
  parseMaxLanesFlag,
  readLaneSlots,
  writeLaneSlots,
  type LaneSlotsState,
} from './lane-slots.js';

const state = (over: Partial<LaneSlotsState> = {}): LaneSlotsState => ({
  maxLanes: 2,
  source: 'config',
  running: ['a', 'b'],
  waiting: ['c', 'd'],
  updatedAt: '2026-11-05T00:00:00.000Z',
  pid: 1,
  ...over,
});

const tmp = createTempDirs();
let dir: string;
beforeEach(() => {
  dir = tmp.makeSync('lane-slots-');
});
afterEach(async () => tmp.cleanup());

describe('formatLaneSlotsSection', () => {
  it('formatLaneSlotsSection shows running against the cap and the waiting lanes', () => {
    expect(formatLaneSlotsSection(state())).toEqual([
      '  lanes 2/2 running (cap from run.maxLanes)',
      '  running: a, b',
      '  waiting for a slot: c, d',
    ]);
    expect(formatLaneSlotsSection(state({ source: 'flag' }))[0]).toContain('cap from --max-lanes');
  });

  it('shows no cap and omits the waiting line when nothing waits', () => {
    expect(formatLaneSlotsSection(state({ maxLanes: null, source: 'unset', waiting: [] }))).toEqual([
      '  lanes 2 running (no cap)',
      '  running: a, b',
    ]);
  });

  it('says no run is active for a null state', () => {
    expect(formatLaneSlotsSection(null)).toEqual(['  (no factory run active)']);
  });
});

describe('lane slots file', () => {
  it('round-trips and clears', () => {
    const file = join(dir, 'nested', 'lane-slots.json');
    writeLaneSlots(file, state());
    expect(readLaneSlots(file)).toEqual(state());
    clearLaneSlots(file);
    expect(existsSync(file)).toBe(false);
    expect(readLaneSlots(file)).toBeNull();
    expect(() => clearLaneSlots(file)).not.toThrow();
  });

  it('fails soft on a corrupt or wrong-shape file', () => {
    const file = join(dir, 'lane-slots.json');
    writeFileSync(file, '{nope');
    expect(readLaneSlots(file)).toBeNull();
    for (const bad of [
      '[]',
      'null',
      JSON.stringify({ ...state(), running: 'a' }),
      JSON.stringify({ ...state(), source: 'x' }),
    ]) {
      writeFileSync(file, bad);
      expect(readLaneSlots(file)).toBeNull();
    }
  });
});

describe('parseMaxLanesFlag', () => {
  it('parseMaxLanesFlag rejects zero, negative and non-integer values', () => {
    for (const bad of ['0', '-1', '2.5', 'abc', '', '01', '99999999999999999999']) {
      expect(() => parseMaxLanesFlag(bad)).toThrow(CliExitError);
    }
    expect(() => parseMaxLanesFlag('0')).toThrow("factory: --max-lanes must be a positive integer (got '0')");
  });

  it('accepts a positive integer and passes undefined through', () => {
    expect(parseMaxLanesFlag('2')).toBe(2);
    expect(parseMaxLanesFlag(undefined)).toBeUndefined();
  });
});
