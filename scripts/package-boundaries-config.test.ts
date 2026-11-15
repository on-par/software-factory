import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import config from '../oxlint.config.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const RULE = 'anti-slop/package-boundaries';
// Built by concatenation so this file does not match its own needle.
const DISABLE_NEEDLE = new RegExp(['(?:eslint|oxlint)-', 'disable[^\\n]*package-', 'boundaries'].join(''));

describe('package boundaries lint rule (#4052)', () => {
  it('enables anti-slop/package-boundaries at error with the stub-eval allowance', () => {
    expect(config.rules?.[RULE]).toEqual(['error', { testingAllowedFiles: ['scripts/eval.ts'] }]);
  });

  it('no override sets the rule', () => {
    const overrides = (config.overrides ?? []).filter((o) => o.rules?.[RULE] !== undefined);
    expect(overrides).toEqual([]);
  });

  it('no file under packages/ or scripts/ carries a disable comment for the rule', () => {
    const listed = execFileSync('git', ['ls-files', '-z', '--', 'packages', 'scripts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = listed.split('\0').filter((file) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(file));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) => DISABLE_NEEDLE.test(readFileSync(resolve(REPO_ROOT, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
