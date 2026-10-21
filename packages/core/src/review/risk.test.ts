import { describe, expect, it } from 'vitest';

import type { RiskTier } from '@on-par/factory-config';

import type { TrustTier } from '../config/repo.js';
import { decideRiskMerge, evaluateRisk } from './risk.js';

const ids = (r: ReturnType<typeof evaluateRisk>) => r.rules.map((x) => x.id);

describe('evaluateRisk', () => {
  it('docs-only change set is low and lists the matched low rules', () => {
    const r = evaluateRisk({ paths: ['docs/guide/setup.md', 'README.md', 'CHANGELOG.md'] });
    expect(r.tier).toBe('low');
    expect(r.rules).toContainEqual({
      id: 'docs',
      tier: 'low',
      paths: ['docs/guide/setup.md', 'README.md', 'CHANGELOG.md'],
    });
    expect(ids(r)).toContain('changelog');
    expect(r.rules.some((x) => x.tier !== 'low')).toBe(false);
  });

  it('migrations and stomp paths are high and list the matching rule', () => {
    const m = evaluateRisk({ paths: ['db/migrations/0001_init.sql'] });
    expect(m.tier).toBe('high');
    expect(ids(m)).toContain('migrations-schema');
    const s = evaluateRisk({ paths: ['src/stomp/client.ts'] });
    expect(s.tier).toBe('high');
    expect(ids(s)).toContain('customer-data');
  });

  it('high wins over med and low on mixed changes', () => {
    const r = evaluateRisk({ paths: ['docs/a.md', 'scripts/release.sh', 'db/migrations/002.sql'] });
    expect(r.tier).toBe('high');
    expect(new Set(r.rules.map((x) => x.tier))).toEqual(new Set(['low', 'med', 'high']));
  });

  it('med wins over low', () => {
    expect(evaluateRisk({ paths: ['docs/a.md', 'scripts/build.sh'] }).tier).toBe('med');
  });

  it('tests-only is low', () => {
    const r = evaluateRisk({ paths: ['packages/core/src/x.test.ts'] });
    expect(r.tier).toBe('low');
    expect(ids(r)).toEqual(['tests-only']);
  });

  it('unmatched path is med', () => {
    const r = evaluateRisk({ paths: ['src/feature.ts'] });
    expect(r.tier).toBe('med');
    expect(r.rules).toEqual([{ id: 'unmatched', tier: 'med', paths: ['src/feature.ts'] }]);
  });

  it('empty input is med (empty-diff)', () => {
    expect(evaluateRisk({ paths: [] })).toEqual({ tier: 'med', rules: [{ id: 'empty-diff', tier: 'med', paths: [] }] });
  });

  it('invalid path is high (invalid-input)', () => {
    const bad: unknown[] = ['', 42, 'docs/a.md'];
    const r = evaluateRisk({ paths: bad as string[] });
    expect(r.tier).toBe('high');
    expect(r.rules.at(-1)).toEqual({ id: 'invalid-input', tier: 'high', paths: ['', ''] });
  });

  it('normalizes paths and de-dupes', () => {
    const r = evaluateRisk({ paths: ['./docs\\a.md', 'docs/a.md'] });
    expect(r.rules).toEqual([{ id: 'docs', tier: 'low', paths: ['docs/a.md'] }]);
  });

  it('supports custom pattern, glob and predicate rules', () => {
    const rules = {
      rules: [
        { id: 'pat', tier: 'high' as const, patterns: ['^core/'] },
        { id: 'glob', tier: 'med' as const, globs: ['lib/*.ts'] },
        { id: 'pred', tier: 'low' as const, predicate: (p: string) => p.endsWith('.txt') },
      ],
    };
    expect(evaluateRisk({ paths: ['core/x.ts'], rules }).tier).toBe('high');
    expect(evaluateRisk({ paths: ['lib/a.ts'], rules }).rules[0]!.id).toBe('glob');
    expect(evaluateRisk({ paths: ['a.txt'], rules })).toEqual({
      tier: 'low',
      rules: [{ id: 'pred', tier: 'low', paths: ['a.txt'] }],
    });
  });

  it('a throwing predicate is high (predicate-error)', () => {
    const rules = {
      rules: [
        {
          id: 'boom',
          tier: 'low' as const,
          predicate: () => {
            throw new Error('x');
          },
        },
      ],
    };
    const r = evaluateRisk({ paths: ['a.ts', 'a.ts', 'b.ts'], rules });
    expect(r.tier).toBe('high');
    expect(r.rules.find((x) => x.id === 'predicate-error')!.paths).toEqual(['a.ts', 'b.ts']);
  });

  it('refactorAllowlist makes a path low (allowlisted-refactor)', () => {
    const rules = { rules: [], refactorAllowlist: ['src/feature.ts'] };
    expect(evaluateRisk({ paths: ['src/feature.ts'], rules })).toEqual({
      tier: 'low',
      rules: [{ id: 'allowlisted-refactor', tier: 'low', paths: ['src/feature.ts'] }],
    });
  });

  it('the highest tier fires within one path', () => {
    const r = evaluateRisk({ paths: ['docs/auth.md'] });
    expect(r.tier).toBe('high');
    expect(ids(r)).toEqual(expect.arrayContaining(['docs', 'auth']));
  });
});

describe('decideRiskMerge', () => {
  const tiers: TrustTier[] = ['T0', 'T1', 'T2'];

  it('low merges on every trust tier with no labels', () => {
    for (const trustTier of tiers) {
      expect(decideRiskMerge({ tier: 'low', trustTier, labels: [] })).toMatchObject({
        merge: true,
        addLabels: [],
        notify: false,
      });
    }
  });

  it('med merges on T2 without needs-human', () => {
    expect(decideRiskMerge({ tier: 'med', trustTier: 'T2', labels: [] }).merge).toBe(true);
  });

  it('med holds with risk:med on T0 and T1', () => {
    for (const trustTier of ['T0', 'T1'] as const) {
      const d = decideRiskMerge({ tier: 'med', trustTier, labels: [] });
      expect(d).toMatchObject({ merge: false, addLabels: ['risk:med'], notify: false });
      expect(d.reason).toContain(`trust tier ${trustTier} is not T2`);
    }
  });

  it('med on T2 holds when needs-human is set', () => {
    const d = decideRiskMerge({ tier: 'med', trustTier: 'T2', labels: ['needs-human'] });
    expect(d).toMatchObject({ merge: false, addLabels: ['risk:med'] });
    expect(d.reason).toContain('needs-human is set');
  });

  it('high holds, labels and notifies on every trust tier', () => {
    for (const trustTier of tiers) {
      expect(decideRiskMerge({ tier: 'high', trustTier, labels: [] })).toMatchObject({
        merge: false,
        addLabels: ['risk:high', 'needs-human'],
        notify: true,
      });
    }
  });

  it('treats an unknown tier as high', () => {
    expect(decideRiskMerge({ tier: 'bogus' as RiskTier, trustTier: 'T2', labels: [] })).toMatchObject({
      merge: false,
      addLabels: ['risk:high', 'needs-human'],
      notify: true,
    });
  });

  it('never adds a factory queue label', () => {
    for (const tier of ['low', 'med', 'high'] as const) {
      for (const trustTier of tiers) {
        const d = decideRiskMerge({ tier, trustTier, labels: [] });
        expect(d.addLabels.some((l) => l.startsWith('factory:'))).toBe(false);
      }
    }
  });
});
