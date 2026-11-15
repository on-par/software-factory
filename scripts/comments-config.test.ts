import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import config, { COMMENTS_BASELINE } from '../oxlint.config.js';
import antiSlopPlugin from '../tools/oxlint/anti-slop/index.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const RULE = 'anti-slop/no-comments';
const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|js|mjs)$/;

describe('comment ban lint rule (#4053)', () => {
  it('enables anti-slop/no-comments at error', () => {
    expect(config.rules?.[RULE]).toBe('error');
  });

  it('caps each baseline file at its recorded allowance', () => {
    const overrides = (config.overrides ?? []).filter((o) => o.rules?.[RULE] !== undefined);
    expect(overrides).toEqual(
      Object.entries(COMMENTS_BASELINE).map(([file, allowed]) => ({
        files: [file.includes('/') ? file : `./${file}`],
        rules: { [RULE]: ['error', { allowed }] },
      })),
    );
    for (const override of overrides) {
      expect(override.rules?.[RULE]).not.toBe('off');
    }
  });

  it('records only existing in-scope files with positive allowances', () => {
    const keys = Object.keys(COMMENTS_BASELINE);
    expect(keys).toEqual([...keys].sort());
    for (const [path, allowed] of Object.entries(COMMENTS_BASELINE)) {
      expect(existsSync(resolve(REPO_ROOT, path)), `${path} exists`).toBe(true);
      expect(path, `${path} is in the rule's scope`).toMatch(SOURCE_EXTENSION);
      expect(Number.isInteger(allowed) && allowed >= 1, `${path} allowance`).toBe(true);
    }
  });

  it('no longer registers require-safety-comment-for-type-assertion', () => {
    expect(antiSlopPlugin.rules).not.toHaveProperty('require-safety-comment-for-type-assertion');
    expect(antiSlopPlugin.rules).toHaveProperty('no-comments');
  });
});
