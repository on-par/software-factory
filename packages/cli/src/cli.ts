#!/usr/bin/env node
// packages/cli/src/cli.ts — CLI entry point

import { main } from './cli/index.js';
import { runEntry } from './entry.js';

void runEntry(main);
