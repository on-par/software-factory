// packages/cli/src/cli/self-update-stop.ts — the self-update drain's STOP files (#3209): marked `self-update`, cleared only while still so.
import { unlinkSync, writeFileSync } from 'node:fs';

import { formatStopMarker, readStopMarker } from '@on-par/factory-core/internal';

/** Writes a self-update STOP exclusively; throws EEXIST when any STOP is already there. */
export function writeSelfUpdateStop(file: string): void {
  writeFileSync(file, formatStopMarker('self-update'), { flag: 'wx' });
}

/** Unlinks one STOP only while its marker still says `self-update`; true when it was removed. */
export function clearSelfUpdateStop(file: string): boolean {
  try {
    if (readStopMarker(file)?.source !== 'self-update') return false;
    unlinkSync(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return false;
  }
}

/** Clears each STOP via `clearSelfUpdateStop`, so a STOP a person set mid-drain survives. */
export function clearSelfUpdateStops(files: string[]): void {
  for (const f of files) clearSelfUpdateStop(f);
}
