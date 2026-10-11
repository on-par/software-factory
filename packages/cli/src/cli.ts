#!/usr/bin/env node
// packages/cli/src/cli.ts — CLI entry point

import { runEntry } from './entry.js';

// index.js is loaded only after runEntry's Node version gate: its graph imports node:sqlite (#2382).
void runEntry(async () => (await import('./cli/index.js')).main());
