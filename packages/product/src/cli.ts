#!/usr/bin/env node
// packages/product/src/cli.ts — CLI entry point

import { main } from './cli/program.js';
import { runEntry } from './entry.js';

void runEntry(main);
