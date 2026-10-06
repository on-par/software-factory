import { describe, expect, it } from 'vitest';

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

  it('throws a clear error when a manifest file is missing', () => {
    const readFile = () => {
      throw new Error('ENOENT: no such file or directory');
    };
    expect(() => loadInjectionFixtures({ readFile })).toThrow(/injection fixture missing/);
  });

  it('names the missing file when only one manifest file is unreadable', () => {
    const readFile = (path: string) => {
      if (path.endsWith('web-content-rewrite-pwned.md')) throw new Error('ENOENT');
      return 'stub CANARY';
    };
    expect(() => loadInjectionFixtures({ readFile })).toThrow(
      /injection fixture missing: .*web-content-rewrite-pwned\.md/,
    );
  });

  it('reads every manifest file through the injected readFile', () => {
    const calls: Array<{ path: string; encoding: string }> = [];
    const readFile = (path: string, encoding: 'utf8') => {
      calls.push({ path, encoding });
      return 'stub CANARY';
    };
    const fixtures = loadInjectionFixtures({ readFile });
    expect(calls).toHaveLength(EXPECTED_NAMES.length);
    EXPECTED_NAMES.forEach((name, i) => {
      expect(calls[i]?.path.endsWith(name)).toBe(true);
      expect(calls[i]?.encoding).toBe('utf8');
    });
    expect(fixtures.every((f) => f.content === 'stub CANARY')).toBe(true);
  });
});
