#!/usr/bin/env node
// packages/product/src/cli.ts — CLI entry point

import { main } from './cli/program.js';

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
