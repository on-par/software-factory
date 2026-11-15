import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { dependencyInstallCommand } from './dependency-install.js';

const tempDirs = createTempDirs();

afterEach(() => tempDirs.cleanup());

describe('dependencyInstallCommand', () => {
  it('takes the first matching lockfile, pnpm before npm, when several exist', async () => {
    const dir = await tempDirs.make('dependency-install-');
    for (const f of ['package.json', 'package-lock.json', 'pnpm-lock.yaml']) await writeFile(join(dir, f), '');
    expect(dependencyInstallCommand(dir)).toEqual(['pnpm', 'install', '--frozen-lockfile']);
  });
});
