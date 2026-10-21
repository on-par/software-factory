import { describe, expect, it } from 'vitest';
import { classifyNoDiff, renderNoDiffDetail, workerOutputTail } from './build-no-diff.js';

describe('classifyNoDiff', () => {
  it.each(['Operation not permitted', 'sandbox_apply', 'sandbox denied', 'EPERM', 'EACCES'])(
    'classifies %s as sandbox',
    (marker) => {
      expect(classifyNoDiff({ output: `boom ${marker} here` })).toBe('sandbox');
    },
  );

  it('lets sandbox beat open questions', () => {
    expect(classifyNoDiff({ output: 'sandbox_apply failed', openQuestions: ['q?'] })).toBe('sandbox');
  });

  it('classifies a plan with an open question as open-questions', () => {
    expect(classifyNoDiff({ output: 'ok', openQuestions: ['q?'] })).toBe('open-questions');
  });

  it('classifies undefined and empty open questions as unknown', () => {
    expect(classifyNoDiff({ output: 'ok' })).toBe('unknown');
    expect(classifyNoDiff({ output: 'ok', openQuestions: [] })).toBe('unknown');
  });

  it('does not match EPERM/EACCES inside a longer word', () => {
    expect(classifyNoDiff({ output: 'EPERMISSION and XEACCESS' })).toBe('unknown');
  });
});

describe('workerOutputTail', () => {
  it('drops blank lines and keeps the last 20', () => {
    const output = Array.from({ length: 30 }, (_, i) => `line ${i}\n\n`).join('');
    const lines = workerOutputTail(output).split('\n');
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('line 10');
    expect(lines[19]).toBe('line 29');
  });

  it('strips ANSI escape codes', () => {
    expect(workerOutputTail('\x1b[31mred\x1b[0m text')).toBe('red text');
  });

  it('redacts a ghp_ token', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    expect(workerOutputTail(`leaked ${token}`)).not.toContain(token);
  });

  it('caps at 2,000 chars keeping the end', () => {
    const tail = workerOutputTail(`${'a'.repeat(5000)}END`);
    expect(tail.length).toBeLessThanOrEqual(2000);
    expect(tail.endsWith('END')).toBe(true);
  });

  it('returns an empty string for empty or blank output', () => {
    expect(workerOutputTail('')).toBe('');
    expect(workerOutputTail('\n  \n\x1b[0m\n')).toBe('');
  });
});

describe('renderNoDiffDetail', () => {
  it('lists at most 3 questions plus a remainder', () => {
    const out = renderNoDiffDetail({
      cause: 'open-questions',
      tail: 'x',
      openQuestions: ['a?', 'b?', 'c?', 'd?', 'e?'],
    });
    expect(out).toContain('- a?');
    expect(out).toContain('- c?');
    expect(out).not.toContain('- d?');
    expect(out).toContain('…and 2 more');
  });

  it('omits the cause line when no cause is given', () => {
    expect(renderNoDiffDetail({ tail: 'x' })).not.toContain('cause:');
  });

  it('renders an empty tail as worker output was empty', () => {
    expect(renderNoDiffDetail({ cause: 'unknown', tail: '' })).toContain('worker output was empty');
  });
});
