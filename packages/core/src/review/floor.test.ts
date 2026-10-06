import { describe, expect, it } from 'vitest';

import {
  applyReviewFloorOverrides,
  computeReviewFloor,
  DEFAULT_REVIEW_FLOOR_RULES,
  type ReviewFloorPathChange,
  type ReviewFloorRuleSet,
} from './floor.js';

const change = (path: string, added = 1, removed = 0): ReviewFloorPathChange => ({
  path,
  added,
  removed,
});
const floorOf = (...paths: string[]) => computeReviewFloor({ changes: paths.map((p) => change(p)) });
const ids = (r: ReturnType<typeof computeReviewFloor>) => r.rules.map((x) => x.id);

describe('computeReviewFloor', () => {
  it('docs-only is A', () => {
    expect(floorOf('docs/adr/0121-x.md', 'README.md')).toEqual({
      floor: 'A',
      rules: [{ id: 'docs-only', class: 'A', paths: ['docs/adr/0121-x.md', 'README.md'] }],
    });
  });

  it('mixed is B and lists only the uncovered path', () => {
    const r = floorOf('README.md', 'packages/core/src/x.ts');
    expect(r.floor).toBe('B');
    expect(r.rules).toEqual([{ id: 'outside-a-scope', class: 'B', paths: ['packages/core/src/x.ts'] }]);
  });

  it('sensitive paths are C', () => {
    expect(floorOf('.github/workflows/ci.yml')).toEqual({
      floor: 'C',
      rules: [
        { id: 'workflows', class: 'C', paths: ['.github/workflows/ci.yml'] },
        { id: 'outside-a-scope', class: 'B', paths: ['.github/workflows/ci.yml'] },
      ],
    });
    const dep = floorOf('package-lock.json', 'docs/a.md');
    expect(dep.floor).toBe('C');
    expect(dep.rules[0]).toEqual({ id: 'dependencies', class: 'C', paths: ['package-lock.json'] });
  });

  it('size escalates strictly above maxLines', () => {
    const max = DEFAULT_REVIEW_FLOOR_RULES.maxLines;
    const over = computeReviewFloor({ changes: [change('docs/a.md', max, 1)] });
    expect(over.floor).toBe('B');
    expect(ids(over)).toEqual(['size']);
    expect(computeReviewFloor({ changes: [change('docs/a.md', max - 1, 1)] }).floor).toBe('A');
  });

  it('empty diff is C', () => {
    expect(computeReviewFloor({ changes: [] })).toEqual({
      floor: 'C',
      rules: [{ id: 'empty-diff', class: 'C', paths: [] }],
    });
  });

  it('tests-only and docs+tests are A', () => {
    expect(floorOf('packages/core/src/a.test.ts').rules[0]?.id).toBe('tests-only');
    const mix = floorOf('docs/a.md', 'packages/core/src/a.test.ts');
    expect(mix.floor).toBe('A');
    expect(ids(mix)).toEqual(['docs-only', 'tests-only']);
  });

  it('merge/land tokens are C, unrelated words are not', () => {
    expect(ids(floorOf('packages/cli/src/cli/merge-scope.ts'))).toContain('merge-land');
    expect(ids(floorOf('scripts/auto-merge-sweep.sh'))).toContain('merge-land');
    expect(ids(floorOf('scripts/repo-merge-settings.sh'))).toContain('merge-land');
    expect(floorOf('docs/island.md').floor).toBe('A');
  });

  it('classifier and sensitive names are C', () => {
    expect(ids(floorOf('packages/core/src/review/floor.ts'))).toContain('classifier');
    expect(ids(floorOf('src/auth/login.ts'))).toContain('sensitive-name');
  });

  it('C plus oversize lists C first and size', () => {
    const r = computeReviewFloor({ changes: [change('src/auth/a.ts', 600)] });
    expect(r.floor).toBe('C');
    expect(ids(r)).toEqual(['sensitive-name', 'outside-a-scope', 'size']);
  });

  it('invalid input is C', () => {
    for (const bad of [change('docs/a.md', -1), change('docs/a.md', Number.NaN), change('')]) {
      const r = computeReviewFloor({ changes: [bad] });
      expect(r.floor).toBe('C');
      expect(r.rules[0]).toEqual({ id: 'invalid-input', class: 'C', paths: [bad.path] });
    }
  });

  it('keeps reporting rules for valid changes alongside invalid ones', () => {
    const r = computeReviewFloor({ changes: [change('', 1), change('src/auth/a.ts')] });
    expect(ids(r)).toEqual(['invalid-input', 'sensitive-name', 'outside-a-scope']);
  });

  it('normalizes paths and ignores case', () => {
    expect(floorOf('./docs/x.md').floor).toBe('A');
    expect(floorOf('docs\\x.md').floor).toBe('A');
    expect(floorOf('README.MD').floor).toBe('A');
  });

  it('honors custom rule sets', () => {
    const noA: ReviewFloorRuleSet = { rules: [], maxLines: 500 };
    expect(computeReviewFloor({ changes: [change('a.md')], rules: noA }).rules).toEqual([
      { id: 'outside-a-scope', class: 'B', paths: ['a.md'] },
    ]);
    const small: ReviewFloorRuleSet = { ...DEFAULT_REVIEW_FLOOR_RULES, maxLines: 2 };
    const r = computeReviewFloor({ changes: [change('a.md', 2, 1)], rules: small });
    expect(ids(r)).toEqual(['size']);
  });

  it('is never A when a non-A path is present', () => {
    const covered = ['docs/a.md', 'README.md', 'x.test.ts'];
    const others = ['src/x.ts', 'src/auth/a.ts', 'package.json', '.github/workflows/a.yml', 'a.sh'];
    for (const o of others) {
      expect(floorOf(...covered, o).floor).not.toBe('A');
    }
  });

  it('does not mutate input', () => {
    const changes = [change('docs/a.md'), change('src/x.ts')];
    const copy = structuredClone(changes);
    computeReviewFloor({ changes });
    expect(changes).toEqual(copy);
  });
});

describe('applyReviewFloorOverrides', () => {
  const floorWith = (o: Parameters<typeof applyReviewFloorOverrides>[0], ...paths: string[]) =>
    computeReviewFloor({ changes: paths.map((p) => change(p)), rules: applyReviewFloorOverrides(o) });

  it('returns the base rules unchanged when nothing is set', () => {
    expect(applyReviewFloorOverrides(undefined)).toBe(DEFAULT_REVIEW_FLOOR_RULES);
    expect(applyReviewFloorOverrides({})).toBe(DEFAULT_REVIEW_FLOOR_RULES);
  });

  it('alwaysHuman adds a C rule and keeps every packaged C rule', () => {
    const r = floorWith({ alwaysHuman: ['infra/', './Ops\\'] }, 'infra/main.tf');
    expect(r.floor).toBe('C');
    expect(ids(r)).toContain('repo-always-human');
    expect(floorWith({ alwaysHuman: ['ops/'] }, 'ops/x.txt').floor).toBe('C');
    const merged = applyReviewFloorOverrides({ alwaysHuman: ['infra/'] });
    const packagedC = DEFAULT_REVIEW_FLOOR_RULES.rules.filter((x) => x.class === 'C').map((x) => x.id);
    expect(merged.rules.map((x) => x.id)).toEqual(expect.arrayContaining(packagedC));
  });

  it('an empty alwaysHuman adds no rule', () => {
    expect(applyReviewFloorOverrides({ alwaysHuman: [] }).rules.map((x) => x.id)).not.toContain('repo-always-human');
  });

  it('matches globs against the whole path', () => {
    expect(floorWith({ alwaysHuman: ['**/*.tf'] }, 'modules/net/main.tf').floor).toBe('C');
    expect(floorWith({ alwaysHuman: ['**/*.tf'] }, 'main.tf').floor).toBe('C');
    expect(floorWith({ alwaysHuman: ['*.tf'] }, 'a.tf').floor).toBe('C');
    expect(floorWith({ alwaysHuman: ['*.tf'] }, 'a/b.tf').floor).toBe('B');
    expect(floorWith({ alwaysHuman: ['a/?.x', 'v1.0/**'] }, 'a/b.x').floor).toBe('C');
    expect(floorWith({ alwaysHuman: ['a/?.x'] }, 'a/bc.x').floor).toBe('B');
    expect(floorWith({ alwaysHuman: ['v1.0/**'] }, 'v1x0/y').floor).toBe('B');
  });

  it('autoEligible replaces the packaged A rules', () => {
    expect(floorWith({ autoEligible: ['site/'] }, 'site/index.html').floor).toBe('A');
    expect(floorWith({ autoEligible: ['site/'] }, 'docs/x.md').floor).toBe('B');
    expect(floorWith({ autoEligible: [] }, 'docs/x.md').floor).toBe('B');
    expect(floorWith({ maxDiffLines: 5 }, 'docs/x.md').floor).toBe('A');
  });

  it('maxDiffLines replaces maxLines', () => {
    const rules = applyReviewFloorOverrides({ maxDiffLines: 10 });
    expect(rules.maxLines).toBe(10);
    expect(computeReviewFloor({ changes: [change('docs/x.md', 11)], rules }).floor).toBe('B');
    expect(applyReviewFloorOverrides({ alwaysHuman: ['x/'] }).maxLines).toBe(DEFAULT_REVIEW_FLOOR_RULES.maxLines);
  });
});
