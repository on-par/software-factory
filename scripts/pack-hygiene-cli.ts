// scripts/pack-hygiene-cli.ts — bin shim: a single runPackHygiene call over the real
// process; the logic and its tests live in pack-hygiene.ts / pack-hygiene.test.ts.
import { readFileSync } from 'node:fs';

import { runPackHygiene } from './pack-hygiene.ts';

process.exitCode = runPackHygiene(process.argv.slice(2), {
  cwd: process.cwd(),
  readFile: (path) => readFileSync(path, 'utf8'),
  err: (text) => process.stderr.write(text),
});
