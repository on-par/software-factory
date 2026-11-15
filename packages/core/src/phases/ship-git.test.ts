import { describe, expect, it } from 'vitest';

import { recorder } from '../test-support/recording-fakes.test.js';
import { claimGuardedRunner, shortDetail } from './ship-git.js';

describe('shortDetail', () => {
  it('uses stdout when stderr is empty', () => {
    expect(
      shortDetail(Object.assign(new Error('command failed'), { stderr: '', stdout: 'nothing added to commit' })),
    ).toBe('nothing added to commit');
  });

  it('prefers stderr when both output streams contain text', () => {
    expect(shortDetail({ stderr: ' fatal: blocked\n', stdout: 'ignored output' })).toBe('fatal: blocked');
  });

  it('uses stdout when stderr is whitespace', () => {
    expect(shortDetail({ stderr: '  \n ', stdout: ' no changes\n' })).toBe('no changes');
  });

  it.each([
    [undefined, undefined, 'fallback'],
    [12, false, 'fallback'],
    ['', ' ', 'fallback'],
  ])('uses the error fallback for non-string or blank outputs', (stderr, stdout, expected) => {
    expect(shortDetail(Object.assign(new Error('fallback'), { stderr, stdout }))).toBe(expected);
  });

  it.each([null, undefined])('handles a %s thrown value', (error) => {
    expect(shortDetail(error)).toBe(String(error));
  });

  it('flattens whitespace and caps detail at 200 characters', () => {
    expect(shortDetail({ stderr: ` first\n  second ${'x'.repeat(250)}` })).toBe(
      `first second ${'x'.repeat(250)}`.slice(0, 200),
    );
  });

  it('returns the existing final fallback for empty error text', () => {
    expect(shortDetail(new Error('  '))).toBe('no error output');
  });
});

describe('claimGuardedRunner (#3146)', () => {
  it('calls the inner runner while the claim is healthy', async () => {
    const inner = recorder(async () => ({ stdout: 'ok' }));
    const run = claimGuardedRunner(new AbortController().signal, inner);
    await expect(run('git push', { cwd: '/wt' })).resolves.toEqual({ stdout: 'ok' });
    expect(inner.calls).toEqual([['git push', { cwd: '/wt' }]]);
  });

  it('rejects with the abort reason without calling the inner runner after abort', () => {
    const controller = new AbortController();
    const lost = new Error('claim lost');
    controller.abort(lost);
    const inner = recorder(async () => ({ stdout: 'ok' }));
    expect(() => claimGuardedRunner(controller.signal, inner)('git push')).toThrow(lost);
    expect(inner.calls).toEqual([]);
  });
});
