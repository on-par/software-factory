import { describe, expect, it } from 'vitest';

import { classifyNoDiff, describeNoDiffFailure, formatNoDiffParkMessage, workerOutputTail } from './build-no-diff.js';

describe('no-diff diagnostics', () => {
  it.each(['Operation not permitted', 'sandbox_apply', 'sandbox denied', 'EPERM', 'EACCES'])(
    'classifies %s as a sandbox failure',
    (marker) => {
      expect(classifyNoDiff({ output: `worker failed: ${marker}` })).toBe('sandbox');
    },
  );

  it('matches marker phrases without case sensitivity', () => {
    expect(classifyNoDiff({ output: 'SANDBOX_APPLY failed' })).toBe('sandbox');
    expect(classifyNoDiff({ output: 'operation NOT permitted' })).toBe('sandbox');
  });

  it('scans the full output and uses sandbox precedence over questions', () => {
    const output = `${'ordinary output\n'.repeat(25)}sandbox denied`;
    expect(classifyNoDiff({ output, openQuestions: ['Should this be changed?'] })).toBe('sandbox');
  });

  it.each(['XEPERM', 'EPERMy', 'EACCES2', 'myEACCES'])('does not match a partial permission marker: %s', (output) => {
    expect(classifyNoDiff({ output })).toBe('unknown');
  });

  it('classifies empty and ANSI-only output as unknown', () => {
    expect(classifyNoDiff({ output: '' })).toBe('unknown');
    expect(classifyNoDiff({ output: '\u001b[31m\u001b[0m' })).toBe('unknown');
    expect(workerOutputTail('\u001b[31m\u001b[0m')).toBe('');
  });

  it('classifies any nonempty question array, including blank entries, as open questions', () => {
    expect(classifyNoDiff({ output: 'ordinary', openQuestions: [''] })).toBe('open-questions');
    expect(classifyNoDiff({ output: '', openQuestions: [] })).toBe('unknown');
  });

  it('keeps the final 20 nonblank lines and normalizes CRLF and lone CR', () => {
    const lines = Array.from({ length: 22 }, (_value, index) => `line-${index + 1}`);
    const tail = workerOutputTail(`${lines.slice(0, 5).join('\r\n')}\r\n  \r${lines.slice(5).join('\r')}`);
    expect(tail.split('\n')).toHaveLength(20);
    expect(tail.split('\n')[0]).toBe('line-3');
    expect(tail.endsWith('line-22')).toBe(true);
  });

  it('redacts secrets before truncating the output tail', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const output = `${'x'.repeat(1500)}${token}${'y'.repeat(800)}`;
    const tail = workerOutputTail(output);
    expect(tail.length).toBeLessThanOrEqual(2000);
    expect(tail).not.toContain('ghp_');
    expect(tail).toContain('<secret>');
  });

  it('reports no-diff cause and sanitized output while junk-only keeps its diagnosis', () => {
    const noDiff = describeNoDiffFailure({ output: 'sandbox_apply: Operation not permitted', baseRef: 'origin/main' });
    expect(noDiff).toMatchObject({ reason: 'no_diff', noDiffCause: 'sandbox' });
    expect(noDiff.detail).toContain('cause: sandbox');
    expect(noDiff.detail).toContain('Worker output (last lines):\nsandbox_apply: Operation not permitted');

    const junk = describeNoDiffFailure({
      output: 'ordinary worker output',
      openQuestions: ['Question?'],
      baseRef: 'origin/main',
      excludedPaths: ['dist/generated.js'],
    });
    expect(junk.reason).toBe('junk_only_diff');
    expect(junk.noDiffCause).toBeUndefined();
    expect(junk.detail).toContain('only generated/cache files');
    expect(junk.detail).toContain('Worker output (last lines):\nordinary worker output');
  });

  it('formats at most three sanitized plan questions and the retained tail', () => {
    const questions = [
      `\u001b[31mFirst question ${'ghp_' + 'a'.repeat(36)}?\u001b[0m`,
      'Second question?',
      'Third question?',
      'Fourth question ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ];
    const message = formatNoDiffParkMessage(
      { reason: 'no_diff', noDiffCause: 'open-questions', workerOutputTail: 'last worker line' },
      questions,
    );
    expect(message).toContain('cause: open-questions');
    expect(message).toContain('- First question');
    expect(message).not.toContain('\u001b');
    expect(message).toContain('- Third question?');
    expect(message).not.toContain('Fourth question');
    expect(message).toContain('<secret>');
    expect(message).toContain('last worker line');
  });

  it('supports legacy missing diagnostics and preserves the junk-only lead', () => {
    expect(formatNoDiffParkMessage({ reason: 'no_diff' })).toContain('cause: unknown');
    const junk = formatNoDiffParkMessage({ reason: 'junk_only_diff' });
    expect(junk).toContain('build changed only generated/cache files');
    expect(junk).not.toContain('cause:');
  });
});
