// packages/config/src/index.ts — Config package: resolve paths to shared config files
//
// Other packages import `resolveConfigPath` to find the JSON configs and
// constitution markdown files shipped by this package.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a config file path from this package's `src/` directory.
 * Works both in dev (from src/) and after build (from dist/ → ../src/).
 */
export function resolveConfigPath(filename: string): string {
  // After build, this file is at dist/index.js; config files are in ../src/
  // In dev (tsx), this file is at src/index.ts; config files are in ./
  const base = __dirname.endsWith('dist') ? resolve(__dirname, '..', 'src') : __dirname;
  return resolve(base, filename);
}

/** Directory containing constitution markdown files */
export const constitutionsDir = resolveConfigPath('constitutions');

/** Re-export the raw JSON for direct import if needed */
export { default as modelsConfig } from './models.json' with { type: 'json' };
export { default as routesConfig } from './routes.json' with { type: 'json' };
export { default as factoryConfig } from './factory.json' with { type: 'json' };