#!/usr/bin/env node
// packages/cli/src/cli.ts — CLI entry point

import { runEntry } from './entry.js';

// index.js and stream-session.js load only after runEntry's Node version gate: their graphs import node:sqlite (#2382).
// The command output session starts before any command runs and is flushed when the command completes.
void runEntry(async () => {
  const session = await import('./stream-session.js');
  await session.startStreamSession();
  try {
    await (await import('./cli/index.js')).main();
  } catch (err) {
    await session.closeStreamSession('error');
    throw err;
  }
  await session.closeStreamSession('exit');
});
