// packages/cli/src/cli/self-update-stop.test.ts — cover clearSelfUpdateStop paths
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatStopMarker } from '@on-par/factory-core/internal';
import { afterEach, describe, expect, it, vi } from 'vitest';

const unlinkSync = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => unlinkSync(...args) };
});

import { clearSelfUpdateStop, writeSelfUpdateStop } from './self-update-stop.js';

afterEach(() => {
  unlinkSync.mockReset();
  unlinkSync.mockImplementation((() => undefined) as typeof import('node:fs').unlinkSync);
});

describe('clearSelfUpdateStop', () => {
  it('returns false on ENOENT from unlink (gone between read and remove)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-self-update-stop-'));
    const file = join(dir, 'STOP');
    writeSelfUpdateStop(file);
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    unlinkSync.mockImplementation(() => {
      throw enoent;
    });
    expect(clearSelfUpdateStop(file)).toBe(false);
  });

  it('removes a self-update STOP and leaves a non-self-update STOP alone', () => {
    unlinkSync.mockImplementation((() => undefined) as typeof import('node:fs').unlinkSync);
    const dir = mkdtempSync(join(tmpdir(), 'sf-self-update-stop-'));
    const selfUpdate = join(dir, 'STOP.self');
    const other = join(dir, 'STOP.other');
    writeSelfUpdateStop(selfUpdate);
    writeFileSync(other, formatStopMarker('manual'));
    expect(clearSelfUpdateStop(selfUpdate)).toBe(true);
    expect(unlinkSync).toHaveBeenCalledWith(selfUpdate);
    expect(clearSelfUpdateStop(other)).toBe(false);
    expect(unlinkSync).toHaveBeenCalledTimes(1);
  });
});
