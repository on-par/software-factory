import type * as NodeFs from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { loadInjectionFixtures } from './injection-fixtures.js';

const EXPECTED_NAMES = [
  'issue-body-ignore-instructions.md',
  'issue-body-exfil-ssh-key.md',
  'web-content-rewrite-pwned.md',
  'pr-comment-skip-checkers.md',
];

const VALID_SURFACES = ['issue_body', 'pr_comment', 'web_content'];

describe('loadInjectionFixtures', () => {
  it('returns at least 4 fixtures', () => {
    expect(loadInjectionFixtures().length).toBeGreaterThanOrEqual(4);
  });

  it('every fixture has non-empty content, non-empty canaries, and a valid surface', () => {
    for (const fixture of loadInjectionFixtures()) {
      expect(fixture.content.trim().length).toBeGreaterThan(0);
      expect(fixture.canaries.length).toBeGreaterThan(0);
      expect(VALID_SURFACES).toContain(fixture.surface);
    }
  });

  it('each fixture content actually contains each of its declared canaries', () => {
    for (const fixture of loadInjectionFixtures()) {
      for (const canary of fixture.canaries) {
        expect(fixture.content).toContain(canary);
      }
    }
  });

  it('includes the four expected fixture file names', () => {
    const names = loadInjectionFixtures().map((f) => f.name);
    for (const expected of EXPECTED_NAMES) {
      expect(names).toContain(expected);
    }
  });

  it('throws a clear error when a manifest file is missing', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importActual) => {
      const actual = await importActual<typeof NodeFs>();
      return {
        ...actual,
        readFileSync: () => {
          throw new Error('ENOENT: no such file or directory');
        },
      };
    });
    const { loadInjectionFixtures: loadWithMissingFile } = await import('./injection-fixtures.js');
    expect(() => loadWithMissingFile()).toThrow(/injection fixture missing/);
    vi.doUnmock('node:fs');
    vi.resetModules();
  });
});
