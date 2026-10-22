import { describe, expect, it, vi } from 'vitest';

import {
  diffMaxLinesBaseline,
  isBotActor,
  overrideLabelVerdict,
  renderGuardFailure,
  runMaxLinesBaselineGuard,
  type GuardIo,
  type LabelEvent,
} from './max-lines-baseline-guard.js';

const labeled = (login: string, type = 'User', event = 'labeled', name = 'max-lines:override'): LabelEvent => ({
  event,
  label: { name },
  actor: { login, type },
});

describe('diffMaxLinesBaseline', () => {
  it('classifies raised, added, lowered, removed and equal entries', () => {
    const diff = diffMaxLinesBaseline({ a: 10, b: 10, c: 10, d: 10 }, { a: 11, b: 9, c: 10, e: 5 });
    expect(diff.raised).toEqual([{ path: 'a', base: 10, head: 11 }]);
    expect(diff.lowered).toEqual([{ path: 'b', base: 10, head: 9 }]);
    expect(diff.added).toEqual([{ path: 'e', head: 5 }]);
    expect(diff.removed).toEqual([{ path: 'd', base: 10 }]);
  });
});

describe('isBotActor', () => {
  it('detects Bot type, [bot] suffix and configured logins, not humans', () => {
    expect(isBotActor({ login: 'x', type: 'Bot' }, [])).toBe(true);
    expect(isBotActor({ login: 'Factory[BOT]' }, [])).toBe(true);
    expect(isBotActor({ login: 'Fac-User' }, [' fac-user ', ''])).toBe(true);
    expect(isBotActor({ login: 'alice', type: 'User' }, [''])).toBe(false);
  });
});

describe('overrideLabelVerdict', () => {
  it('is absent without a label, after unlabeled, or without an actor; ignores other labels', () => {
    expect(overrideLabelVerdict([], [])).toEqual({ kind: 'absent' });
    expect(overrideLabelVerdict([labeled('a'), labeled('a', 'User', 'unlabeled')], [])).toEqual({ kind: 'absent' });
    expect(overrideLabelVerdict([labeled('a', 'User', 'labeled', 'other')], [])).toEqual({ kind: 'absent' });
    expect(
      overrideLabelVerdict([{ event: 'labeled', label: { name: 'max-lines:override' }, actor: null }], []),
    ).toEqual({ kind: 'absent' });
  });

  it('is human for a human labeler, and a later human label beats a bot label', () => {
    expect(overrideLabelVerdict([labeled('alice')], [])).toEqual({ kind: 'human', actor: 'alice' });
    expect(overrideLabelVerdict([labeled('app[bot]', 'Bot'), labeled('alice')], [])).toEqual({
      kind: 'human',
      actor: 'alice',
    });
  });

  it('treats a Bot-type, [bot]-suffixed or configured-login labeler as a bot and the failure says the label must be applied by a human', () => {
    const diff = diffMaxLinesBaseline({ a: 1 }, { a: 2 });
    for (const event of [labeled('x', 'Bot'), labeled('y[bot]'), labeled('Svc')]) {
      const verdict = overrideLabelVerdict([event], ['svc']);
      expect(verdict.kind).toBe('bot');
      expect(renderGuardFailure(diff, verdict).join('\n')).toContain('must be applied by a human');
    }
  });
});

function io(
  overrides: Partial<GuardIo> & { base?: string; head: string },
): GuardIo & { errors: string[]; logs: string[] } {
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    env: { GITHUB_REPOSITORY: 'o/r' },
    git: () => overrides.base ?? '{}',
    readHead: () => overrides.head,
    fetchLabelEvents: () => [],
    ...overrides,
    log: (l) => logs.push(l),
    error: (l) => errors.push(l),
    errors,
    logs,
  };
}

const ARGS = ['--base', 'abc', '--pr', '7'];

describe('runMaxLinesBaselineGuard', () => {
  const raise = { base: '{"a.ts":600}', head: '{"a.ts":650,"b.ts":700}' };

  it('fails naming each raised and added entry and the Human override docs when the label is absent', () => {
    const h = io(raise);
    expect(runMaxLinesBaselineGuard(ARGS, h)).toBe(1);
    const out = h.errors.join('\n');
    expect(out).toContain('a.ts from 600 to 650');
    expect(out).toContain('b.ts at 700');
    expect(out).toContain('#human-override');
  });

  it('passes a raise when the latest max-lines:override label was applied by a human', () => {
    const h = io({ ...raise, fetchLabelEvents: () => [labeled('alice')] });
    expect(runMaxLinesBaselineGuard(ARGS, h)).toBe(0);
    expect(h.logs.join('\n')).toContain('approved by alice');
  });

  it('fails when a bot applied the label', () => {
    const h = io({ ...raise, fetchLabelEvents: () => [labeled('bot[bot]', 'Bot')] });
    expect(runMaxLinesBaselineGuard(ARGS, h)).toBe(1);
    expect(h.errors.join('\n')).toContain('bot[bot]');
  });

  it('passes a lower-or-remove-only diff without the label and without calling the API', () => {
    const fetchLabelEvents = vi.fn(() => []);
    const h = io({ base: '{"a.ts":600,"b.ts":700}', head: '{"a.ts":550}', fetchLabelEvents });
    expect(runMaxLinesBaselineGuard(ARGS, h)).toBe(0);
    expect(fetchLabelEvents).not.toHaveBeenCalled();
  });

  it('counts every entry as added when the base file is missing', () => {
    const h = io({
      head: '{"a.ts":600}',
      git: () => {
        throw new Error('path does not exist');
      },
    });
    expect(runMaxLinesBaselineGuard(ARGS, h)).toBe(1);
    expect(h.errors.join('\n')).toContain('a.ts at 600');
  });

  it('returns 2 on bad args', () => {
    expect(runMaxLinesBaselineGuard(['--base', 'x'], io({ head: '{}' }))).toBe(2);
    expect(runMaxLinesBaselineGuard(['--base', 'x', '--pr', 'nope'], io({ head: '{}' }))).toBe(2);
  });

  it('fails closed on invalid JSON, a bad value, a missing repo, and a fetch failure', () => {
    expect(runMaxLinesBaselineGuard(ARGS, io({ head: '{"a":"x"}' }))).toBe(1);
    expect(runMaxLinesBaselineGuard(ARGS, io({ head: '[]' }))).toBe(1);
    expect(runMaxLinesBaselineGuard(ARGS, io({ head: 'nope' }))).toBe(1);
    expect(runMaxLinesBaselineGuard(ARGS, io({ ...raise, env: {} }))).toBe(1);
    const h = io({
      ...raise,
      fetchLabelEvents: () => {
        throw new Error('gh down');
      },
    });
    expect(runMaxLinesBaselineGuard(ARGS, h)).toBe(1);
    expect(h.errors.join('\n')).toContain('gh down');
  });
});
