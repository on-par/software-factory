import { describe, expect, it } from 'vitest';

import {
  adrFilename,
  adrNumberFromFilename,
  adrSlug,
  formatAdrNumber,
  nextAdrNumber,
  nextAdrNumberFromFilenames,
} from './numbering.js';

describe('formatAdrNumber', () => {
  it('zero-pads to the default width', () => {
    expect(formatAdrNumber(1)).toBe('0001');
  });

  it('honors a custom width', () => {
    expect(formatAdrNumber(1, 2)).toBe('01');
  });

  it('does not truncate a number wider than the pad width', () => {
    expect(formatAdrNumber(12345, 4)).toBe('12345');
  });
});

describe('adrNumberFromFilename', () => {
  it('reads a dash-separated filename', () => {
    expect(adrNumberFromFilename('0003-my-decision.md')).toBe(3);
  });

  it('reads a dot-separated filename', () => {
    expect(adrNumberFromFilename('1.my-decision.md')).toBe(1);
  });

  it('strips leading directories', () => {
    expect(adrNumberFromFilename('docs/adr/0007-x.md')).toBe(7);
  });

  it('returns undefined when there is no leading number', () => {
    expect(adrNumberFromFilename('README.md')).toBeUndefined();
  });

  it('returns undefined for an empty filename', () => {
    expect(adrNumberFromFilename('')).toBeUndefined();
  });

  it('strips a leading Windows-style directory', () => {
    expect(adrNumberFromFilename('docs\\adr\\0009-y.md')).toBe(9);
  });
});

describe('nextAdrNumber', () => {
  it('returns 1 for an empty list', () => {
    expect(nextAdrNumber([])).toBe(1);
  });

  it('returns one past the max', () => {
    expect(nextAdrNumber([1, 3, 2])).toBe(4);
  });
});

describe('nextAdrNumberFromFilenames', () => {
  it('ignores files with no leading number', () => {
    expect(nextAdrNumberFromFilenames(['0001-a.md', '0003-b.md', 'README.md'])).toBe(4);
  });

  it('returns 1 for an empty list', () => {
    expect(nextAdrNumberFromFilenames([])).toBe(1);
  });
});

describe('adrSlug', () => {
  it('lowercases and dasherizes', () => {
    expect(adrSlug('Use X Instead Of Y')).toBe('use-x-instead-of-y');
  });

  it('collapses runs of non-alphanumerics and trims edges', () => {
    expect(adrSlug('  Hello, World!!  ')).toBe('hello-world');
  });

  it('handles en/em dashes in real titles', () => {
    expect(adrSlug('Boss–worker–checker pipeline')).toBe('boss-worker-checker-pipeline');
    expect(adrSlug('Boss—worker—checker pipeline')).toBe('boss-worker-checker-pipeline');
  });
});

describe('adrFilename', () => {
  it('combines the padded number and slug', () => {
    expect(adrFilename(5, 'Use X')).toBe('0005-use-x.md');
  });

  it('honors a custom width', () => {
    expect(adrFilename(5, 'Use X', 2)).toBe('05-use-x.md');
  });
});
