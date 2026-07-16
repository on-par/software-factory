#!/usr/bin/env node
// packages/cli/src/cli.ts — CLI entry point

import { main } from './cli/index.js';

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
