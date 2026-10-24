// packages/cli/src/cli/self-update-stop.test.ts — cover clearSelfUpdateStop ENOENT path (#self-update STOP)
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatStopMarker } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';

import { clearSelfUpdateStop, clearSelfUpdateStops, writeSelfUpdateStop } from './self-update-stop.js';

describe('clearSelfUpdateStop', () => {
  it('returns false when the STOP file is already gone (ENOENT)', () => {
    const missing = join(tmpdir(), `sf-self-update-stop-missing-${process.pid}-${Date.now()}`);
    expect(clearSelfUpdateStop(missing)).toBe(false);
  });

  it('removes a self-update STOP and leaves a non-self-update STOP alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-self-update-stop-'));
    const selfUpdate = join(dir, 'STOP.self');
    const other = join(dir, 'STOP.other');
    writeSelfUpdateStop(selfUpdate);
    writeFileSync(other, formatStopMarker('manual'));
    expect(clearSelfUpdateStop(selfUpdate)).toBe(true);
    expect(clearSelfUpdateStop(other)).toBe(false);
    clearSelfUpdateStops([selfUpdate, other, join(dir, 'STOP.gone')]);
  });
});
