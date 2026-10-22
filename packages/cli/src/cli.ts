#!/usr/bin/env node
// packages/cli/src/cli.ts — CLI entry point

import module from 'node:module';
import { runEntry } from './entry.js';

// Compile cache before the CLI graph loads (#3251); undefined on Node < 22.1 so the Node gate still prints.
module.enableCompileCache?.();

// bin-main.js is loaded only after runEntry's Node version gate (#2382); it builds the program without the engine (#3251).
void runEntry(async () => (await import('./cli/bin-main.js')).binMain());
