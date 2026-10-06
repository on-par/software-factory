import { describe, expect, it } from 'vitest';

import type { DiffRunner } from '../checkers/design-smells.js';
import { DEFAULT_REVIEW_FLOOR_RULES } from './floor.js';
import { classifierGateReason, parseNumstat, readReviewFloorChanges, resolveReviewRouting } from './routing.js';

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
