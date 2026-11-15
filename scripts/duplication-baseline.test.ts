import { describe, expect, it } from 'vitest';

import { runDuplicationBaselineCli } from './duplication-baseline.js';

function report(clones: number, percentage: number, duplicates: unknown[] = []): string {
  return JSON.stringify({ statistics: { total: { clones, percentage } }, duplicates });
}

function duplicate(lines: number, tokens: number, first: string) {
  return {
    lines,
    tokens,
    firstFile: { name: first, start: 1, end: lines },
    secondFile: { name: 'other.ts', start: 10, end: 10 + lines },
  };
}

function run(reportRaw: string, baselineRaw: string) {
  const lines: string[] = [];
  const code = runDuplicationBaselineCli(['report.json', 'baseline.json'], {
    readFile: (p) => (p === 'report.json' ? reportRaw : baselineRaw),
    log: (l) => lines.push(l),
  });
  return { code, text: lines.join('\n'), lines };
}

const baseline = JSON.stringify({ clones: 10, percentage: 2.5 });

describe('runDuplicationBaselineCli', () => {
  it('passes when clones and percentage equal the baseline', () => {
    const { code, text } = run(report(10, 2.5), baseline);
    expect(code).toBe(0);
    expect(text).toContain('duplication: PASS');
    expect(text).not.toContain('clones dropped');
    expect(text).toContain('measured 10 clones, 2.5% (baseline 10, 2.5%)');
  });

  it('fails when the clone count rises above the baseline', () => {
    const { code, text } = run(report(11, 2.5), baseline);
    expect(code).toBe(1);
    expect(text).toContain('duplication: FAIL — clones rose above duplication-baseline.json');
  });

  it('fails when clones rise even though the percentage drops', () => {
    const { code, text } = run(report(11, 2.4), baseline);
    expect(code).toBe(1);
    expect(text).toContain('duplication: FAIL — clones rose above duplication-baseline.json');
  });

  it('passes when only the percentage rises', () => {
    const { code, text } = run(report(10, 3.1), baseline);
    expect(code).toBe(0);
    expect(text).toContain('duplication: PASS');
    expect(text).not.toContain('FAIL');
  });

  it('passes with a notice when clones drop while the percentage rises', () => {
    const { code, text } = run(report(9, 2.6), baseline);
    expect(code).toBe(0);
    expect(text).toContain('duplication: PASS — clones dropped');
    expect(text).not.toContain('FAIL');
  });

  it('passes and prints suggested lower numbers when clones drop', () => {
    const { code, text } = run(report(9, 2.4567), baseline);
    expect(code).toBe(0);
    expect(text).toContain(
      'duplication: PASS — clones dropped; you may lower duplication-baseline.json to {"clones": 9, "percentage": 2.46}',
    );
  });

  it('fails on a missing or malformed report', () => {
    for (const raw of ['not json', '{}', JSON.stringify({ statistics: { total: { clones: 'x', percentage: 1 } } })]) {
      const { code, text } = run(raw, baseline);
      expect(code).toBe(1);
      expect(text).toContain('duplication: FAIL — cannot read report report.json');
    }
  });

  it('fails on a malformed baseline', () => {
    for (const raw of ['nope', '{"clones": 1}', '[]']) {
      const { code, text } = run(report(10, 2.5), raw);
      expect(code).toBe(1);
      expect(text).toContain('duplication: FAIL — cannot read baseline baseline.json');
    }
  });

  it('lists at most 10 clone groups, largest first', () => {
    const duplicates = Array.from({ length: 12 }, (_, i) => duplicate(5 + i, 60, `f${i}.ts`));
    const { lines } = run(report(10, 2.5, duplicates), baseline);
    const numbered = lines.filter((l) => /^\d+\. /.test(l));
    expect(numbered).toHaveLength(10);
    expect(numbered[0]).toContain('16 lines, 60 tokens: f11.ts:1-16 <-> other.ts:10-26');
    expect(numbered[9]).toContain('f2.ts');
  });

  it('breaks ties by tokens then first path', () => {
    const duplicates = [duplicate(5, 60, 'b.ts'), duplicate(5, 70, 'z.ts'), duplicate(5, 60, 'a.ts')];
    const { lines } = run(report(10, 2.5, duplicates), baseline);
    const numbered = lines.filter((l) => /^\d+\. /.test(l));
    expect(numbered.map((l) => l.split(': ')[1]?.split(':')[0])).toEqual(['z.ts', 'a.ts', 'b.ts']);
  });
});
