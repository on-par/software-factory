import { describe, expect, it } from 'vitest';

import { createLineFramer, LINE_CAP, type OutputSegment, WITHHELD_RUN } from './line-framer.js';
import { createRedactor } from './redactor.js';

const KNOWN = 'plainsecretvaluewithoutanydigits';
const GH = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const redactor = createRedactor([KNOWN, 'Basic dXNlcjpwYXNzd29yZA==']);

/** Joins segments back into text: a segment not marked partial ended a line. */
const join = (segs: OutputSegment[]) => segs.map((s) => `${s.text}${s.partial ? '' : '\n'}`).join('');

/** Feeds `parts` through a fresh framer and returns every segment, including the end flush. */
function frame(parts: (Buffer | string)[], redact: (t: string) => string = (t) => t, holdBack = 1024) {
  const framer = createLineFramer(redact, holdBack);
  return [...parts.flatMap((p) => framer.push(p)), ...framer.end()];
}

describe('createLineFramer', () => {
  it('frames lines, marks the unterminated tail partial, and reports UTF-8 byte offsets', () => {
    const segs = frame(['one\ntw', 'o\nthr', 'ee']);
    expect(segs.map((s) => [s.text, s.partial, s.offset])).toEqual([
      ['one', false, 0],
      ['two', false, 4],
      ['three', true, 8],
    ]);
  });

  it('decodes multibyte UTF-8 split at every byte boundary without loss', () => {
    const text = 'é 漢字 🚀 ñ\nü 🚀\n';
    const bytes = Buffer.from(text, 'utf-8');
    for (let i = 1; i < bytes.length; i++) {
      expect(join(frame([bytes.subarray(0, i), bytes.subarray(i)]))).toBe(text);
    }
    const oneByOne = frame([...bytes].map((b) => Buffer.from([b])));
    expect(join(oneByOne)).toBe(text);
  });

  it('accepts already decoded string chunks', () => {
    expect(join(frame(['a 🚀', ' b\n']))).toBe('a 🚀 b\n');
  });

  it('cuts a long line without a newline at whitespace into capped partial segments, losing nothing', () => {
    const line = 'lorem ipsum dolor sit amet '.repeat(8_000);
    const segs = frame([line.slice(0, 70_000), line.slice(70_000)]);
    expect(segs.length).toBeGreaterThan(10);
    for (const s of segs) expect(s.text.length).toBeLessThanOrEqual(LINE_CAP);
    expect(segs.every((s) => s.partial)).toBe(true);
    expect(join(segs)).toBe(line);
  });

  it('never leaks a known secret or a token pattern split across chunks at any offset', () => {
    const line = `start ${KNOWN} middle ${GH} auth: Bearer abc.def-ghi token=hunter2hunter2 end`;
    const expected = `${redactor.redact(line)}\n`;
    const bytes = Buffer.from(`${line}\n`, 'utf-8');
    for (let i = 1; i < bytes.length; i++) {
      for (const j of [i + 1, i + 7, bytes.length - 1]) {
        if (j <= i || j >= bytes.length) continue;
        const parts = [bytes.subarray(0, i), bytes.subarray(i, j), bytes.subarray(j)];
        const out = join(frame(parts, redactor.redact, redactor.holdBack));
        expect(out).toBe(expected);
      }
    }
    expect(expected).not.toContain(KNOWN);
    expect(expected).not.toContain(GH);
    expect(expected).not.toContain('hunter2hunter2');
  });

  it('never leaks a secret that falls on a forced cut inside a long line, at many positions', () => {
    const filler = 'word '.repeat(LINE_CAP / 5 + 50);
    for (let k = -64; k <= 64; k += 3) {
      const pos = LINE_CAP - redactor.holdBack + k;
      const head = filler.slice(0, pos);
      const line = `${head}Basic dXNlcjpwYXNzd29yZA== ${KNOWN} Bearer tok.en-${k} ${filler}`;
      const segs = frame([line], redactor.redact, redactor.holdBack);
      const out = join(segs);
      expect(out).not.toContain('dXNlcjpwYXNzd29yZA==');
      expect(out).not.toContain(KNOWN);
      expect(out).not.toContain(`tok.en-${k}`);
      expect(out.replace(/\[redacted\]|<secret>/g, '').length).toBeGreaterThan(filler.length);
    }
  });

  it('withholds a giant whitespace-free run with bounded output and resumes after it', () => {
    const framer = createLineFramer(redactor.redact, redactor.holdBack);
    const segs: OutputSegment[] = [...framer.push('before ')];
    const block = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 16; i++) segs.push(...framer.push(block));
    segs.push(...framer.push(' after\nnext line\n'), ...framer.end());
    const out = join(segs);
    expect(out).not.toContain('x'.repeat(64));
    expect(out.match(new RegExp(WITHHELD_RUN.replace(/[[\]]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(out).toContain(' after\nnext line\n');
    expect(out.length).toBeLessThan(LINE_CAP);
    expect(segs.find((s) => s.text === WITHHELD_RUN)?.withheld).toBe(true);
  });

  it('withholds a run that ends exactly at the end of the stream', () => {
    const out = join(frame(['y'.repeat(LINE_CAP * 3)], redactor.redact, redactor.holdBack));
    expect(out).toBe(WITHHELD_RUN);
  });

  it('flushes a short unterminated tail at end and redacts it', () => {
    const out = join(frame([`fail ${KNOWN}`], redactor.redact, redactor.holdBack));
    expect(out).toBe('fail [redacted]');
  });
});
