// packages/core/src/config/ratchet-section.test.ts — the `ratchet` config section (#3542)

import { describe, expect, it } from 'vitest';

import { resolveRatchetConfig } from '../ratchet/index.js';
import { FactoryConfigSchema, loadFactoryConfig } from './index.js';

describe('resolveRatchetConfig', () => {
  const list = { name: 'max-lines', file: '.ratchet/max-lines.txt', check: 'npm run lint' };

  it('parses ratchet.lists and defaults lane to auto', () => {
    const config = { ...loadFactoryConfig(), ratchet: { lists: [list], lane: 'auto' } };
    expect(resolveRatchetConfig(config)).toEqual({ lists: [list], lane: 'auto' });
    const parsed = FactoryConfigSchema.parse({ ...loadFactoryConfig(), ratchet: { lists: [list] } });
    expect(resolveRatchetConfig(parsed).lane).toBe('auto');
  });

  it('gives no lists when the key is absent', () => {
    expect(resolveRatchetConfig(loadFactoryConfig())).toEqual({ lists: [], lane: 'auto' });
  });

  it('rejects a list name that is not a slug', () => {
    const bad = { ...loadFactoryConfig(), ratchet: { lists: [{ ...list, name: 'Bad Name' }] } };
    expect(FactoryConfigSchema.safeParse(bad).success).toBe(false);
  });
});
