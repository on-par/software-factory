// src/adr/similarity.test.ts — normalized ADR-title duplicate matching tests (#1439).
import { describe, expect, it } from 'vitest';

import { normalizeAdrTitle } from './similarity.js';

describe('normalizeAdrTitle', () => {
  it('lowercases, collapses punctuation, and removes only a leading article', () => {
    expect(normalizeAdrTitle('A SHIP push whose success the PR depends on is verified, never best-effort')).toBe(
      'ship push whose success the pr depends on is verified never best effort',
    );
  });
});
