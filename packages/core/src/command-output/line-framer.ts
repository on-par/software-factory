// src/command-output/line-framer.ts — turns one output stream's chunks into redacted line segments with bounded
// memory: UTF-8 decoding that survives split multibyte characters, line framing, a line cap with a hold-back so
// a secret is never split by a cut, and a bounded skip over giant whitespace-free runs.

import { StringDecoder } from 'node:string_decoder';

/** Longest segment emitted (characters); a longer line is cut into partial segments. */
export const LINE_CAP = 16_384;
/** Stands in for a whitespace-free run too long to cut safely inside a line longer than the cap. */
export const WITHHELD_RUN = '[factory: unbroken run withheld]';
/** Earlier cut points tried before a long line falls back to withholding. */
const MAX_CUT_TRIES = 16;

export interface OutputSegment {
  /** Redacted text, without the line's newline. */
  text: string;
  /** True when the segment did not end a line (cut at the cap, a withheld run, or the stream's unterminated tail). */
  partial: boolean;
  /** UTF-8 byte offset of the segment's first character in the decoded stream, before redaction. */
  offset: number;
  withheld?: true;
}

export interface LineFramer {
  push(chunk: Buffer | string): OutputSegment[];
  /** Flushes the decoder and the unterminated tail. */
  end(): OutputSegment[];
}

const WHITESPACE = /\s/;

/** Index just after the last whitespace at or before `limit` where cutting changes no redaction, or 0. A cut is
 *  safe when redacting both halves gives the same text as redacting the whole window (at least `holdBack`
 *  characters past the cut), so no known value or pattern match spans it. */
function findCut(buf: string, limit: number, lineCap: number, redact: (t: string) => string): number {
  const window = buf.slice(0, lineCap);
  const whole = redact(window);
  let end = limit;
  for (let tries = 0; tries < MAX_CUT_TRIES; tries++) {
    let ws = end;
    while (ws >= 0 && !WHITESPACE.test(window[ws] ?? '')) ws--;
    if (ws < 0) return 0;
    const cut = ws + 1;
    if (redact(window.slice(0, cut)) + redact(window.slice(cut)) === whole) return cut;
    end = ws - 1;
  }
  return 0;
}

/** A framer for one stream. `holdBack` (characters) must be at least the longest known secret and below `lineCap`. */
export function createLineFramer(
  redact: (text: string) => string,
  holdBack: number,
  lineCap: number = LINE_CAP,
): LineFramer {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let offset = 0;
  let skipping = false;

  const take = (n: number): { raw: string; start: number } => {
    const start = offset;
    const raw = buf.slice(0, n);
    buf = buf.slice(n);
    offset += Buffer.byteLength(raw, 'utf-8');
    return { raw, start };
  };

  const drain = (final: boolean): OutputSegment[] => {
    const out: OutputSegment[] = [];
    for (;;) {
      if (skipping) {
        const ws = buf.search(WHITESPACE);
        take(ws < 0 ? buf.length : ws);
        if (ws < 0) return out;
        skipping = false;
      }
      const nl = buf.indexOf('\n');
      if (nl >= 0 && nl <= lineCap) {
        const { raw, start } = take(nl + 1);
        out.push({ text: redact(raw.slice(0, -1)), partial: false, offset: start });
        continue;
      }
      if (buf.length <= lineCap) {
        if (final && buf.length > 0) {
          const { raw, start } = take(buf.length);
          out.push({ text: redact(raw), partial: true, offset: start });
        }
        return out;
      }
      const cut = findCut(buf, lineCap - holdBack, lineCap, redact);
      if (cut > 0) {
        const { raw, start } = take(cut);
        out.push({ text: redact(raw), partial: true, offset: start });
        continue;
      }
      out.push({ text: WITHHELD_RUN, partial: true, offset, withheld: true });
      skipping = true;
    }
  };

  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      return drain(false);
    },
    end() {
      buf += decoder.end();
      return drain(true);
    },
  };
}
