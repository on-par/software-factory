import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getFactoryPaths } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { attachedRunLocks } from './self-update-apply.js';

describe('attachedRunLocks per-issue locks', () => {
  const tmp = createTempDirs();
  let dir: string;
  beforeEach(() => {
    dir = tmp.makeSync('self-update-locks-');
  });
  afterEach(() => tmp.cleanup());

  it('attachedRunLocks counts a repo whose only live lock is a per-issue run lock', async () => {
    const repo = join(dir, 'issue-only');
    const lock = join(getFactoryPaths(repo).runLocks, '7');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), String(process.pid));
    const registryFile = join(dir, 'registry.json');
    writeFileSync(
      registryFile,
      JSON.stringify({
        version: 1,
        repos: { 'acme/issue-only': { path: repo, attachedAt: 'x', state: 'active' } },
      }),
    );
    expect(await attachedRunLocks(registryFile)).toEqual(['acme/issue-only']);
  });
});
