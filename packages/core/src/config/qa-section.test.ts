import { describe, expect, it } from 'vitest';

import { RepoFactoryConfigV2Schema } from './repo.js';

describe('qa block (#3253)', () => {
  it('parses with defaults', () => {
    const parsed = RepoFactoryConfigV2Schema.parse({
      version: 2,
      qa: { start: ['npm', 'start'], smoke: ['npm', 'run', 'smoke'] },
    });
    expect(parsed.qa).toEqual({
      start: ['npm', 'start'],
      smoke: ['npm', 'run', 'smoke'],
      readyPath: '/',
      readyTimeoutSeconds: 60,
    });
  });

  it('rejects unknown keys, a readyPath without a leading slash, and an empty start', () => {
    const ok = (qa: unknown) => RepoFactoryConfigV2Schema.safeParse({ version: 2, qa }).success;
    expect(ok({ bogus: 1 })).toBe(false);
    expect(ok({ readyPath: 'health' })).toBe(false);
    expect(ok({ start: [] })).toBe(false);
    expect(ok({ start: ['x'], smoke: ['y'], readyPath: '/health', readyTimeoutSeconds: 5 })).toBe(true);
  });
});
