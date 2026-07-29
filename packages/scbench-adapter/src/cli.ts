#!/usr/bin/env node
// packages/scbench-adapter/src/cli.ts — scbench-factory-agent bin entry.
import { main } from './cli-run.js';

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
