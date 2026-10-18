// packages/cli/src/cli/self-update-stop.ts — the self-update drain's STOP files (#3209): marked `self-update`, cleared only while still so.
import { unlinkSync, writeFileSync } from 'node:fs';

import { formatStopMarker, readStopMarker } from '@on-par/factory-core/internal';

/** Writes a self-update STOP exclusively; throws EEXIST when any STOP is already there. */
export function writeSelfUpdateStop(file: string): void {
  writeFileSync(file, formatStopMarker('self-update'), { flag: 'wx' });
}

/** Unlinks each STOP only while its marker still says `self-update`, so a STOP a person set mid-drain survives. */
export function clearSelfUpdateStops(files: string[]): void {
  for (const f of files) {
    try {
      if (readStopMarker(f)?.source !== 'self-update') continue;
      unlinkSync(f);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
