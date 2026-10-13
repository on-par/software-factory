import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Constitution } from '../types/index.js';
import { findTemplateTokens, isTemplateToken, preflightConfigTokens } from './template-tokens.js';

const CF = '.factory/constitution.md';
const fm = (text: string) => findTemplateTokens(text, CF, 'frontmatter');

describe('isTemplateToken', () => {
  it('is true for a whole token, ignoring surrounding whitespace', () => {
    expect(isTemplateToken('<checker-name>')).toBe(true);
    expect(isTemplateToken(' <project name> ')).toBe(true);
  });

  it('is false for non-tokens and mid-string tokens', () => {
    for (const v of ['lint', 'lint<x>', 'custom_<x>', '<1abc>', '<>', '']) expect(isTemplateToken(v)).toBe(false);
  });
});

describe('findTemplateTokens', () => {
  it('reports frontmatter tokens with 1-based lines and the exact message', () => {
    const f = fm('---\nproduct: <project-name>\ncheckers:\n  - compile\n  - <checker-name>\n---\nbody\n');
    expect(f.map((x) => x.line)).toEqual([2, 5]);
    expect(f[0]?.message).toBe(
      ".factory/constitution.md:2: unfilled template token '<project-name>'. Replace it with a real value",
    );
  });

  it('ignores body tokens, missing and unterminated frontmatter', () => {
    expect(fm('---\nproduct: a\n---\n<One paragraph: ...>\n')).toEqual([]);
    expect(fm('product: <x>\n')).toEqual([]);
    expect(fm('---\nproduct: <x>\n')).toEqual([]);
  });

  it('keeps line numbers with CRLF and a BOM', () => {
    expect(fm('﻿---\r\nproduct: a\r\nname: <n>\r\n---\r\n').map((x) => x.line)).toEqual([3]);
  });

  it('ignores full-line and trailing comments', () => {
    expect(fm('---\n# <a>\nk: v # <b>\n---\n')).toEqual([]);
  });

  it('ignores non-token angle brackets', () => {
    for (const v of ['a <= b', 'npm test 2>&1', 'cmd < in > out', 'type: Array<string>']) {
      expect(findTemplateTokens(v, 'f', 'all')).toEqual([]);
    }
  });

  it('reports several tokens on one line', () => {
    const f = findTemplateTokens('k: <a> <b>', 'f', 'all');
    expect(f.map((x) => [x.token, x.line])).toEqual([
      ['<a>', 1],
      ['<b>', 1],
    ]);
  });

  it('scans every line with all scope', () => {
    const f = findTemplateTokens('models:\n  pins:\n    build: <model id>', '.factory/config.yaml', 'all');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ line: 3, file: '.factory/config.yaml' });
  });
});

describe('preflightConfigTokens', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'template-tokens-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const constitution = (absPath: string, repo = true): Constitution => ({
    source: 'repo',
    product: 'acme',
    version: 1,
    checkers: [],
    body: '',
    path: absPath,
    requireTests: true,
    ...(repo ? { repoInstance: { relPath: CF, absPath } } : {}),
  });

  it('returns [] for null, no repoInstance, missing and clean files', () => {
    const c = join(dir, 'c.md');
    writeFileSync(c, '---\nproduct: a\n---\n');
    expect(preflightConfigTokens({ constitution: null })).toEqual([]);
    expect(preflightConfigTokens({ constitution: constitution(c, false) })).toEqual([]);
    expect(
      preflightConfigTokens({
        constitution: constitution(join(dir, 'nope.md')),
        configFile: { absPath: join(dir, 'nope.yaml'), relPath: 'x' },
      }),
    ).toEqual([]);
    expect(preflightConfigTokens({ constitution: constitution(c), configFile: { absPath: c, relPath: 'c' } })).toEqual(
      [],
    );
  });

  it('returns constitution findings before config findings', () => {
    const c = join(dir, 'c.md');
    const y = join(dir, 'config.yaml');
    writeFileSync(c, '---\nproduct: <p>\n---\n');
    writeFileSync(y, 'a: <q>\n');
    const f = preflightConfigTokens({
      constitution: constitution(c),
      configFile: { absPath: y, relPath: '.factory/config.yaml' },
    });
    expect(f.map((x) => x.file)).toEqual([CF, '.factory/config.yaml']);
  });
});
