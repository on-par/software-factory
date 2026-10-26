import { describe, expect, it } from 'vitest';

import type { DiffRunner } from '../checkers/design-smells.js';
import { DEFAULT_REVIEW_FLOOR_RULES } from './floor.js';
import {
  classifierGateReason,
  decideT1Sample,
  parseNumstat,
  readReviewFloorChanges,
  resolveReviewRouting,
  t1SampleValue,
  type ReviewRouting,
} from './routing.js';

const rules = DEFAULT_REVIEW_FLOOR_RULES;

describe('parseNumstat', () => {
  it('parses added/removed/path and skips blank lines', () => {
    expect(parseNumstat('3\t1\tsrc/a.ts\n\n10\t0\tdocs/b.md\n')).toEqual([
      { path: 'src/a.ts', added: 3, removed: 1 },
      { path: 'docs/b.md', added: 10, removed: 0 },
    ]);
  });

  it('turns a binary file’s "-" counts into NaN', () => {
    const [change] = parseNumstat('-\t-\timg.png\n');
    expect(change.path).toBe('img.png');
    expect(Number.isNaN(change.added)).toBe(true);
    expect(Number.isNaN(change.removed)).toBe(true);
  });
});

describe('classifierGateReason', () => {
  it('joins the floor class and fired rule ids', () => {
    expect(
      classifierGateReason({
        floor: 'C',
        rules: [
          { id: 'workflows', class: 'C', paths: ['.github/workflows/ci.yml'] },
          { id: 'x', class: 'B', paths: [] },
        ],
      }),
    ).toBe('classifier:floor:C:workflows,x');
  });
});

describe('resolveReviewRouting', () => {
  const route = (changes: { path: string; added: number; removed: number }[]) =>
    resolveReviewRouting({ worktree: '/w', rules, readChanges: async () => changes });

  it('docs-only ⇒ A, not gated', async () => {
    const r = await route([{ path: 'docs/guide.md', added: 2, removed: 0 }]);
    expect(r.floor).toBe('A');
    expect(r.gated).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it('a workflow change ⇒ C, gated with a rule-bearing reason', async () => {
    const r = await route([{ path: '.github/workflows/ci.yml', added: 1, removed: 0 }]);
    expect(r.floor).toBe('C');
    expect(r.gated).toBe(true);
    expect(r.reason).toMatch(/^classifier:floor:C:workflows/);
  });

  it('a source change ⇒ B, gated', async () => {
    const r = await route([{ path: 'src/x.ts', added: 1, removed: 0 }]);
    expect(r.floor).toBe('B');
    expect(r.gated).toBe(true);
  });

  it('a throwing reader fails closed', async () => {
    const r = await resolveReviewRouting({
      worktree: '/w',
      rules,
      readChanges: async () => {
        throw new Error('boom');
      },
    });
    expect(r).toEqual({ floor: null, rules: [], gated: true, reason: 'classifier:error', error: 'boom' });
  });

  it('passes parentBaseRef to readChanges (#2716)', async () => {
    const seen: (string | undefined)[] = [];
    await resolveReviewRouting({
      worktree: '/w',
      fallbackBaseRef: 'deadbeef',
      parentBaseRef: 'slice-1',
      rules,
      readChanges: async (_w, _f, p) => {
        seen.push(p);
        return [];
      },
    });
    expect(seen).toEqual(['slice-1']);
  });
});

describe('readReviewFloorChanges', () => {
  function fakeRun(handlers: Record<string, { ok: boolean; stdout?: string }>): {
    run: DiffRunner;
    calls: string[];
  } {
    const calls: string[] = [];
    const run: DiffRunner = async (argv) => {
      const key = argv.join(' ');
      calls.push(key);
      const hit = Object.entries(handlers).find(([k]) => key.startsWith(k));
      const res = hit?.[1] ?? { ok: false };
      return { ok: res.ok, stdout: res.stdout ?? '' };
    };
    return { run, calls };
  }

  it('diffs against the merge-base of origin/main and includes untracked files', async () => {
    const { run, calls } = fakeRun({
      'git rev-parse --verify --quiet origin/main': { ok: true },
      'git merge-base origin/main HEAD': { ok: true, stdout: 'abc123\n' },
      'git diff --numstat --no-renames abc123': { ok: true, stdout: '1\t2\tsrc/a.ts\n' },
      'git ls-files --others': { ok: true, stdout: 'new.txt\nempty.txt\n' },
    });
    const files: Record<string, string> = { '/w/new.txt': 'a\nb\n', '/w/empty.txt': '' };
    const changes = await readReviewFloorChanges('/w', { run, readFile: (p) => files[p] });
    expect(changes).toEqual([
      { path: 'src/a.ts', added: 1, removed: 2 },
      { path: 'new.txt', added: 2, removed: 0 },
      { path: 'empty.txt', added: 0, removed: 0 },
    ]);
    expect(calls).toContain('git diff --numstat --no-renames abc123');
  });

  it('diffs against the merge-base of parentBaseRef and never tries origin/main (#2716)', async () => {
    const { run, calls } = fakeRun({
      'git rev-parse --verify --quiet slice-1': { ok: true },
      'git merge-base slice-1 HEAD': { ok: true, stdout: 'def456\n' },
      'git diff --numstat --no-renames def456': { ok: true, stdout: '3\t1\tsrc/b.ts\n' },
      'git ls-files --others': { ok: true },
    });
    const changes = await readReviewFloorChanges('/w', { run, parentBaseRef: 'slice-1' });
    expect(changes).toEqual([{ path: 'src/b.ts', added: 3, removed: 1 }]);
    expect(calls).toContain('git diff --numstat --no-renames def456');
    expect(calls.some((c) => c.includes('origin/main'))).toBe(false);
  });

  it('throws when parentBaseRef does not resolve, without falling back (#2716)', async () => {
    const { run, calls } = fakeRun({
      'git rev-parse --verify --quiet origin/main': { ok: true },
    });
    await expect(readReviewFloorChanges('/w', { run, parentBaseRef: 'slice-1' })).rejects.toThrow(/does not resolve/);
    expect(calls.some((c) => c.includes('origin/main'))).toBe(false);
  });

  it('uses the ref itself when merge-base fails', async () => {
    const { run, calls } = fakeRun({
      'git rev-parse --verify --quiet origin/main': { ok: true },
      'git diff --numstat --no-renames origin/main': { ok: true },
      'git ls-files --others': { ok: true },
    });
    await readReviewFloorChanges('/w', { run });
    expect(calls).toContain('git diff --numstat --no-renames origin/main');
  });

  it('falls back to fallbackBaseRef', async () => {
    const { run, calls } = fakeRun({
      'git rev-parse --verify --quiet deadbeef': { ok: true },
      'git diff --numstat --no-renames deadbeef': { ok: true },
      'git ls-files --others': { ok: true },
    });
    await readReviewFloorChanges('/w', { run, fallbackBaseRef: 'deadbeef' });
    expect(calls).toContain('git diff --numstat --no-renames deadbeef');
  });

  it('throws when no base ref resolves', async () => {
    const { run } = fakeRun({});
    await expect(readReviewFloorChanges('/w', { run })).rejects.toThrow(/no base ref/);
  });

  it('throws when numstat fails', async () => {
    const { run } = fakeRun({ 'git rev-parse --verify --quiet origin/main': { ok: true } });
    await expect(readReviewFloorChanges('/w', { run })).rejects.toThrow(/numstat/);
  });

  it('throws when listing untracked files fails', async () => {
    const { run } = fakeRun({
      'git rev-parse --verify --quiet origin/main': { ok: true },
      'git diff --numstat': { ok: true },
    });
    await expect(readReviewFloorChanges('/w', { run })).rejects.toThrow(/ls-files/);
  });
});

describe('t1SampleValue (#1958)', () => {
  it('is deterministic and in [0,1)', () => {
    for (const [repo, issue] of [
      ['o/r', 1],
      ['o/r', 1958],
      ['On-Par/Software_Factory', 99999],
    ] as const) {
      const v = t1SampleValue(repo, issue);
      expect(t1SampleValue(repo, issue)).toBe(v);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('varies with the issue and the repo', () => {
    expect(t1SampleValue('o/r', 1)).not.toBe(t1SampleValue('o/r', 2));
    expect(t1SampleValue('o/r', 1)).not.toBe(t1SampleValue('o/q', 1));
  });
});

describe('decideT1Sample (#1958)', () => {
  const aFloor: ReviewRouting = { floor: 'A', rules: [], gated: false };
  const input = { repo: 'o/r', issue: 7 };
  const value = t1SampleValue('o/r', 7);

  it('holds a sample below the rate at T1', () => {
    const out = decideT1Sample(aFloor, { trustTier: 'T1', t1SampleRate: value + 0.01 }, input);
    expect(out).toMatchObject({
      gated: true,
      reason: expect.stringContaining('t1-sampled'),
      sample: { value, held: true },
    });
  });

  it('does not hold a sample at or above the rate, but records it', () => {
    const out = decideT1Sample(aFloor, { trustTier: 'T1', t1SampleRate: value }, input);
    expect(out.gated).toBe(false);
    expect(out.reason).toBeUndefined();
    expect(out.sample).toEqual({ value, rate: value, held: false });
  });

  it('never samples at rate 0', () => {
    expect(decideT1Sample(aFloor, { trustTier: 'T1', t1SampleRate: 0 }, input).gated).toBe(false);
  });

  it('returns the routing untouched at T0 and T2 even when the sample is below the rate', () => {
    for (const trustTier of ['T0', 'T2'] as const) {
      expect(decideT1Sample(aFloor, { trustTier, t1SampleRate: 1 }, input)).toBe(aFloor);
    }
  });

  it('never ungates a classifier:error routing', () => {
    const errored: ReviewRouting = { floor: null, rules: [], gated: true, reason: 'classifier:error', error: 'x' };
    expect(decideT1Sample(errored, { trustTier: 'T1', t1SampleRate: 1 }, input)).toBe(errored);
  });

  it('leaves a C floor gated with its own reason', () => {
    const c: ReviewRouting = { floor: 'C', rules: [], gated: true, reason: 'classifier:floor:C:workflows' };
    expect(decideT1Sample(c, { trustTier: 'T1', t1SampleRate: 1 }, input)).toBe(c);
  });
});
