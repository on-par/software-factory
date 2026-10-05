#!/usr/bin/env node
// packages/scbench-adapter/src/cli.ts — scbench-factory-agent bin entry.
import { main } from './cli-run.js';
import { runEntry } from './entry.js';

void runEntry(() => main(process.argv.slice(2)));
