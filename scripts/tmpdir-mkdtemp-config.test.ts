import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import config, { TMPDIR_MKDTEMP_BASELINE } from '../oxlint.config.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const RULE = 'anti-slop/no-direct-tmpdir-mkdtemp';
const SCANNED = /^packages\/[^/]+\/src\/(?:.*\.test\.tsx?|(?:.*\/)?test-support\/.*\.tsx?)$/;
const HELPER = 'packages/core/src/harness/temp-dir.ts';

describe('direct tmpdir mkdtemp lint rule (#3114, #4050)', () => {
  it('enables anti-slop/no-direct-tmpdir-mkdtemp at error', () => {
    expect(config.rules?.[RULE]).toBe('error');
  });

  it('caps each baseline file at its recorded allowance', () => {
    const overrides = (config.overrides ?? []).filter((o) => o.rules?.[RULE] !== undefined);
    expect(overrides).toEqual(
      Object.entries(TMPDIR_MKDTEMP_BASELINE).map(([file, allowed]) => ({
        files: [file],
        rules: { [RULE]: ['error', { allowed }] },
      })),
    );
    for (const override of overrides) {
      expect(override.rules?.[RULE]).not.toBe('off');
    }
  });

  it('records only existing test or test-support files with positive allowances', () => {
    const keys = Object.keys(TMPDIR_MKDTEMP_BASELINE);
    expect(keys).toEqual([...keys].sort());
    for (const [path, allowed] of Object.entries(TMPDIR_MKDTEMP_BASELINE)) {
      expect(existsSync(resolve(REPO_ROOT, path)), `${path} exists`).toBe(true);
      expect(path, `${path} is in the rule's scope`).toMatch(SCANNED);
      expect(path).not.toBe(HELPER);
      expect(Number.isInteger(allowed) && allowed >= 1, `${path} allowance`).toBe(true);
    }
  });
});
