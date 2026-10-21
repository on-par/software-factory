import { describe, expect, it } from 'vitest';
import { syncLandBranch } from './internal.js';

describe('internal exports', () => {
  it('exports the land sync helper without exposing it from the root API', async () => {
    const root = await import('./index.js');
    expect(syncLandBranch).toBeTypeOf('function');
    expect(root).not.toHaveProperty('syncLandBranch');
  });
});
