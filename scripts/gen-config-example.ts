// scripts/gen-config-example.ts — Regenerate docs/config.example.jsonc from the config schemas.
//
// Usage: npm run build && npm run config-example
// packages/core/src/config/example.test.ts fails when the committed file is stale.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderConfigExample } from '@on-par/factory-core/internal';

const target = fileURLToPath(new URL('../docs/config.example.jsonc', import.meta.url));
writeFileSync(target, renderConfigExample());
console.log(`wrote ${target}`);
