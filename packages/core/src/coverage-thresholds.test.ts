import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Guards the coverage gate contract in the root vitest.config.ts (#242):
// per-package threshold globs keep one workspace from hiding another
// workspace's regression behind the aggregate average, and CI uploads the
// summary/LCOV/Cobertura artifacts, so both must stay present.
const configText = readFileSync(fileURLToPath(new URL('../../../vitest.config.ts', import.meta.url)), 'utf8');

describe('root coverage gate', () => {
  it.each(['config', 'core', 'cli', 'dashboard'])('declares a package-scoped threshold glob for packages/%s', (pkg) => {
    expect(configText).toContain(`'packages/${pkg}/src/**/*.{ts,tsx}':`);
  });

  it.each(['json-summary', 'lcov', 'cobertura'])('keeps the %s coverage reporter CI uploads', (reporter) => {
    expect(configText).toContain(`'${reporter}'`);
  });
});
