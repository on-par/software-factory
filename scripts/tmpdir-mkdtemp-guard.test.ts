import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { countDirectTmpdirMkdtemp, TMPDIR_MKDTEMP_BASELINE } from './tmpdir-mkdtemp-baseline.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const HELPER = 'packages/core/src/harness/temp-dir.ts';
const SCANNED = /^packages\/[^/]+\/src\/(?:.*\.test\.tsx?|(?:.*\/)?test-support\/.*\.tsx?)$/;

function scanned(): Map<string, number> {
  const files = execFileSync('git', ['ls-files', 'packages'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((path) => SCANNED.test(path) && path !== HELPER);
  const counts = new Map<string, number>();
  for (const path of files) {
    const count = countDirectTmpdirMkdtemp(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
    if (count > 0) counts.set(path, count);
  }
  return counts;
}

describe('direct tmpdir mkdtemp ratchet (#3114)', () => {
  it('countDirectTmpdirMkdtemp counts mkdtemp(join(tmpdir(), ...)) and mkdtempSync(path.join(os.tmpdir(), ...))', () => {
    expect(countDirectTmpdirMkdtemp("mkdtemp(join(tmpdir(), 'x-'))")).toBe(1);
    expect(countDirectTmpdirMkdtemp("mkdtempSync(path.join(os.tmpdir(), 'x-'))")).toBe(1);
    expect(countDirectTmpdirMkdtemp("await mkdtemp(\n  join(\n    tmpdir(),\n    'x-',\n  ),\n)")).toBe(1);
    expect(countDirectTmpdirMkdtemp('mkdtemp(tmpdir())')).toBe(1);
    expect(countDirectTmpdirMkdtemp("createTempDirs().make('x-')")).toBe(0);
    expect(countDirectTmpdirMkdtemp("mkdtemp(join(root, 'x-'))")).toBe(0);
  });

  it('no test file exceeds its baseline count of direct tmpdir mkdtemp calls', () => {
    for (const [path, count] of scanned()) {
      expect(
        count,
        `${path} has ${count} direct mkdtemp(tmpdir()) calls; use createTempDirs from @on-par/factory-core/testing`,
      ).toBeLessThanOrEqual(TMPDIR_MKDTEMP_BASELINE[path] ?? 0);
    }
  });

  it('baseline has no stale entries', () => {
    const actual = scanned();
    for (const [path, recorded] of Object.entries(TMPDIR_MKDTEMP_BASELINE)) {
      expect(actual.get(path) ?? 0, `${path} baseline is stale: lower or delete the entry`).toBe(recorded);
    }
  });
});
