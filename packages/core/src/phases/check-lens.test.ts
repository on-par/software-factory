import { describe, expect, it } from 'vitest';

import type { CheckSummary } from '../types/index.js';
import { lensShowstopperRefs, remainingShowstoppers, stuckSignature } from './check.js';

function lensSummary(details: string, result: 'FAIL' | 'PASS' = 'FAIL'): CheckSummary {
  return {
    failures: result === 'FAIL' ? 1 : 0,
    passes: result === 'PASS' ? 1 : 0,
    skips: 0,
    total: 1,
    results: [{ checker: 'lens_review', result, details }],
  };
}

describe('lensShowstopperRefs', () => {
  it('parses file:line refs from showstopper lines', () => {
    expect(
      lensShowstopperRefs(
        'src/a.ts:12 — x. Failure scenario: y (lenses: security)\nsrc/b.ts:3 — z. Failure scenario: w (lenses: techlead, product)',
      ),
    ).toEqual(['src/a.ts:12', 'src/b.ts:3']);
  });

  it('sorts and de-duplicates', () => {
    expect(lensShowstopperRefs('b.ts:1 — x\na.ts:2 — y\na.ts:2 — z')).toEqual(['a.ts:2', 'b.ts:1']);
  });

  it('accepts bullets, leading whitespace and dash variants', () => {
    expect(lensShowstopperRefs('- a.ts:1 — x\n  * b.ts:2 - y\n• c.ts:3 – z')).toEqual(['a.ts:1', 'b.ts:2', 'c.ts:3']);
  });

  it('skips headers and unparsable text', () => {
    expect(lensShowstopperRefs('2 showstoppers:\na.ts:1 — x')).toEqual(['a.ts:1']);
    expect(lensShowstopperRefs('')).toEqual([]);
    expect(lensShowstopperRefs('lens security returned malformed JSON')).toEqual([]);
  });

  it('keeps a Windows drive path intact', () => {
    expect(lensShowstopperRefs('C:\\x\\a.ts:12 — s')).toEqual(['C:\\x\\a.ts:12']);
  });
});

describe('stuckSignature for lens_review', () => {
  const sig = (s: CheckSummary) => stuckSignature(s, new Set());

  it('is equal for the same refs regardless of wording or order', () => {
    const a = lensSummary(
      'a.ts:1 — one. Failure scenario: s (lenses: security)\nb.ts:2 — two. Failure scenario: t (lenses: product)',
    );
    const b = lensSummary(
      'b.ts:2 — other words. Failure scenario: q (lenses: techlead)\na.ts:1 — new text. Failure scenario: r (lenses: a, b)',
    );
    expect(sig(a)).toBe(sig(b));
  });

  it('differs when refs differ', () => {
    expect(sig(lensSummary('a.ts:1 — x'))).not.toBe(sig(lensSummary('a.ts:2 — x')));
  });

  it('falls back to normalized detail when no refs parse', () => {
    expect(sig(lensSummary('lens security returned malformed JSON'))).toBe(
      'lens_review:lens security returned malformed json',
    );
    expect(sig(lensSummary('reason one'))).not.toBe(sig(lensSummary('reason two')));
  });

  it('leaves other checkers on normalized detail', () => {
    const t = (d: string): CheckSummary => ({
      failures: 1,
      passes: 0,
      skips: 0,
      total: 1,
      results: [{ checker: 'tests', result: 'FAIL', details: d }],
    });
    expect(sig(t('3 failed'))).toBe(sig(t('4 failed')));
    expect(sig(t('3 failed'))).toBe('tests:# failed');
  });
});

describe('remainingShowstoppers', () => {
  it('returns trimmed showstopper lines of a lens_review FAIL', () => {
    expect(remainingShowstoppers(lensSummary('2 showstoppers:\n  - a.ts:1 — x\nb.ts:2 — y'))).toEqual([
      '- a.ts:1 — x',
      'b.ts:2 — y',
    ]);
  });

  it('is empty when lens_review passes or is absent', () => {
    expect(remainingShowstoppers(lensSummary('a.ts:1 — x', 'PASS'))).toEqual([]);
    expect(remainingShowstoppers({ failures: 0, passes: 0, skips: 0, total: 0, results: [] })).toEqual([]);
  });
});
