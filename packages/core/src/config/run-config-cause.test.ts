import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadFactoryConfigForRepo } from './index.js';
import { loadRepoConfig } from './repo.js';

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the call to throw');
}

describe('malformed FACTORY_RUN_CONFIG_JSON', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('loadFactoryConfigForRepo attaches the SyntaxError as cause', () => {
    vi.stubEnv('FACTORY_RUN_CONFIG_JSON', '{nope');
    const err = thrown(() => loadFactoryConfigForRepo('/nonexistent/config.json'));
    expect(err.message).toContain('Failed to parse');
    expect(err.cause).toBeInstanceOf(SyntaxError);
  });

  it('loadRepoConfig attaches the SyntaxError as cause', () => {
    vi.stubEnv('FACTORY_RUN_CONFIG_JSON', '{nope');
    const root = mkdtempSync(join(tmpdir(), 'run-config-cause-'));
    try {
      const err = thrown(() => loadRepoConfig(root));
      expect(err.message).toContain('Failed to parse');
      expect(err.cause).toBeInstanceOf(SyntaxError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
