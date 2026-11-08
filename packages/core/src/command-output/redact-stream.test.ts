import { describe, expect, it } from 'vitest';

import { createLineRedactor } from './redact-stream.js';

const enc = (s: string) => new TextEncoder().encode(s);
const token = () => ['gh', 'p_', 'A1b2'.repeat(9)].join('');

function setup(maxLineBytes?: number) {
  const lines: string[] = [];
  const r = createLineRedactor((l) => lines.push(l), maxLineBytes === undefined ? {} : { maxLineBytes });
  return { lines, r };
}

describe('createLineRedactor', () => {
  it('redacts a token split across two chunks', () => {
    const { lines, r } = setup();
    const t = token();
    r.write(enc(`key ${t.slice(0, 10)}`));
    r.write(enc(`${t.slice(10)} done\n`));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[redacted]');
    expect(lines[0]).not.toContain(t);
    expect(lines[0]).not.toContain(t.slice(10));
  });

  it('redacts a token split across a multi-byte UTF-8 boundary', () => {
    const { lines, r } = setup();
    const t = token();
    const bytes = enc(`é ${t}\n`);
    r.write(bytes.slice(0, 1));
    r.write(bytes.slice(1, 8));
    r.write(bytes.slice(8));
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('é ')).toBe(true);
    expect(lines[0]).toContain('[redacted]');
    expect(lines[0]).not.toContain(t);
  });

  it('emits each complete line as soon as its newline arrives', () => {
    const { lines, r } = setup();
    r.write(enc('one\r\ntwo\nthr'));
    expect(lines).toEqual(['one', 'two']);
    r.write(enc('ee\n'));
    expect(lines).toEqual(['one', 'two', 'three']);
  });

  it('withholds an over-long run with no whitespace', () => {
    const { lines, r } = setup(10);
    r.write(enc('x'.repeat(25)));
    expect(lines).toEqual(['[withheld: 25 chars without whitespace]']);
  });

  it('force-flushes an over-long line at its last whitespace', () => {
    const { lines, r } = setup(10);
    r.write(enc('aaa bbb ccccc'));
    expect(lines).toEqual(['aaa bbb']);
    r.end();
    expect(lines).toEqual(['aaa bbb', ' ccccc']);
  });

  it('flushes a trailing partial line on end', () => {
    const { lines, r } = setup();
    r.write(enc('partial'));
    expect(lines).toEqual([]);
    r.end();
    expect(lines).toEqual(['partial']);
  });

  it('ignores writes after end', () => {
    const { lines, r } = setup();
    r.end();
    r.write(enc('late\n'));
    r.end();
    expect(lines).toEqual([]);
  });

  it('keeps framing when the consumer throws', () => {
    const seen: string[] = [];
    const r = createLineRedactor((l) => {
      seen.push(l);
      throw new Error('boom');
    });
    r.write(enc('a\nb\n'));
    expect(seen).toEqual(['a', 'b']);
  });
});
