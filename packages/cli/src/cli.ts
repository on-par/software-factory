#!/usr/bin/env node
// packages/cli/src/cli.ts — CLI entry point

import { runEntry } from './entry.js';

// index.js and stream-session.js load only after runEntry's Node version gate: their graphs import node:sqlite (#2382).
// The command stream session starts first, before any command runs, for every CLI command.
void runEntry(async () => {
  (await import('./stream-session.js')).startStreamSession();
  await (await import('./cli/index.js')).main();
});
