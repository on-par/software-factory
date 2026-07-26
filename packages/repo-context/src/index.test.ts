import { describe, expect, it } from 'vitest';

import * as repoContext from './index.js';

describe('index barrel', () => {
  it('re-exports the public surface of all five modules', () => {
    expect(repoContext.createFsReader).toBeTypeOf('function');
    expect(repoContext.createGitHubContentsReader).toBeTypeOf('function');
    expect(repoContext.createInMemoryReader).toBeTypeOf('function');
    expect(repoContext.normalizeRepoPath).toBeTypeOf('function');
    expect(repoContext.joinRepoPath).toBeTypeOf('function');
    expect(repoContext.EMPTY_DIR).toEqual([]);
    expect(Object.isFrozen(repoContext.EMPTY_DIR)).toBe(true);
    expect(repoContext.DEFAULT_GITHUB_API_BASE_URL).toBe('https://api.github.com');
    expect(repoContext.DEFAULT_MAX_FILE_BYTES).toBe(1_000_000);
  });
});
