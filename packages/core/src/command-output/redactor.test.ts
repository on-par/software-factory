import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createStreamRedactor } from './redactor.js';

const fakeToken = () => ['gh', 'p', '_'].join('') + 'a1B2'.repeat(9);

describe('createStreamRedactor (#3994)', () => {
  it('emits each complete line as soon as its newline arrives', () => {
    const r = createStreamRedactor({ env: {} });
    expect(r.push('one\ntwo\n')).toEqual(['one\n', 'two\n']);
  });

  it('holds a partial line until its newline or end', () => {
    const r = createStreamRedactor({ env: {} });
    expect(r.push('par')).toEqual([]);
    expect(r.push('tial')).toEqual([]);
    expect(r.end()).toEqual(['partial']);
    expect(r.end()).toEqual([]);
  });

  it('redacts a GitHub token split across two chunks', () => {
    const r = createStreamRedactor({ env: {} });
    const t = fakeToken();
    const out = [...r.push(`token ${t.slice(0, 10)}`), ...r.push(`${t.slice(10)}\n`)];
    expect(out.join('')).not.toContain(t.slice(0, 10));
    expect(out.join('')).toContain('[redacted]');
  });

  it('redacts a token split inside a UTF-8 multi-byte boundary', () => {
    const r = createStreamRedactor({ env: {} });
    const t = fakeToken();
    const bytes = Buffer.from(`é ${t}\n`);
    const out = [...r.push(bytes.subarray(0, 1)), ...r.push(bytes.subarray(1))];
    expect(out.join('')).toBe('é [redacted]\n');
  });

  it('redacts a configured credential env value split across chunks', () => {
    const value = ['opaque', 'value', Date.now()].join('-');
    const r = createStreamRedactor({ env: { GH_TOKEN: value } });
    const out = [...r.push(`x ${value.slice(0, 8)}`), ...r.push(`${value.slice(8)} y\n`)];
    expect(out).toEqual(['x [redacted] y\n']);
  });

  it('redacts a private key block spanning lines', () => {
    const begin = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ');
    const end = ['-----END RSA', 'PRIVATE KEY-----'].join(' ');
    const r = createStreamRedactor({ env: {} });
    const out = [...r.push(`before\n${begin}\nabc\n`), ...r.push(`def\n${end}\nafter\n`), ...r.end()];
    expect(out).toEqual(['before\n', '<secret>\n', 'after\n']);
  });

  it('cuts an oversized pending run only at a separator and replaces a separator-free run with <secret>', () => {
    const r = createStreamRedactor({ env: {}, maxPendingChars: 20 });
    expect(r.push('word '.repeat(6))).toEqual(['word word word word word word ']);
    const r2 = createStreamRedactor({ env: {}, maxPendingChars: 20 });
    expect(r2.push('a'.repeat(30))).toEqual(['<secret>']);
    expect(r2.end()).toEqual([]);
  });

  it('new capture test sources hold no contiguous credential literal', () => {
    const files = [
      './redactor.test.ts',
      './capture.test.ts',
      '../utils/command-runner.on-output.test.ts',
      '../checkers/run-command.capture.test.ts',
      '../checkers/app-smoke.capture.test.ts',
      '../utils/exec.capture.test.ts',
      '../phases/check.capture-scope.test.ts',
    ];
    const pattern = new RegExp(
      [
        'gh[pousr]_[A-Za-z0-9]{20,}',
        ['github', 'pat', ''].join('_'),
        ['-----BEGIN [A-Z ]*PRIVATE', 'KEY'].join(' '),
      ].join('|'),
    );
    for (const f of files) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(pattern.test(src), f).toBe(false);
    }
  });
});
