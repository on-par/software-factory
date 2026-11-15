import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import config, { CALL_ASSERTIONS_BASELINE } from '../oxlint.config.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const RULE = 'anti-slop/no-call-assertions';
const SCANNED = /^(?:packages\/[^/]+\/src\/(?:.*\.test\.tsx?|(?:.*\/)?test-support\/.*\.tsx?)|scripts\/.*\.test\.ts)$/;
// Built by concatenation so this file does not match its own needle.
const DISABLE_NEEDLE = new RegExp(['(?:eslint|oxlint)-', 'disable[^\\n]*\\b', 'no-call-', 'assertions\\b'].join(''));

describe('call-count assertion lint rule (#4051)', () => {
  it('enables anti-slop/no-call-assertions at error', () => {
    expect(config.rules?.[RULE]).toBe('error');
  });

  it('caps each baseline file at its recorded allowance', () => {
    const overrides = (config.overrides ?? []).filter((o) => o.rules?.[RULE] !== undefined);
    expect(overrides).toEqual(
      Object.entries(CALL_ASSERTIONS_BASELINE).map(([file, allowed]) => ({
        files: [file],
        rules: { [RULE]: ['error', { allowed }] },
      })),
    );
    for (const override of overrides) {
      expect(override.rules?.[RULE]).not.toBe('off');
    }
  });

  it('records only existing in-scope files with positive allowances', () => {
    const keys = Object.keys(CALL_ASSERTIONS_BASELINE);
    expect(keys).toEqual([...keys].sort());
    for (const [path, allowed] of Object.entries(CALL_ASSERTIONS_BASELINE)) {
      expect(existsSync(resolve(REPO_ROOT, path)), `${path} exists`).toBe(true);
      expect(path, `${path} is in the rule's scope`).toMatch(SCANNED);
      expect(Number.isInteger(allowed) && allowed >= 1, `${path} allowance`).toBe(true);
    }
  });

  it('no in-scope file carries a disable directive for anti-slop/no-call-assertions', () => {
    const listed = execFileSync('git', ['ls-files', '-z', '--', 'packages', 'scripts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = listed.split('\0').filter((file) => file !== '' && SCANNED.test(file));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) => DISABLE_NEEDLE.test(readFileSync(resolve(REPO_ROOT, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
