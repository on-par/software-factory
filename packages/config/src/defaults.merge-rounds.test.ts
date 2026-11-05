import { describe, expect, it } from 'vitest';

import { defaultFactoryConfig } from './defaults.js';

describe('shipped merge defaults (#1887)', () => {
  it('ships merge.maxConflictRounds 2', () => {
    expect(defaultFactoryConfig.merge.maxConflictRounds).toBe(2);
  });
});
