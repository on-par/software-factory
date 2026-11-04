import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { mergeChangelogUnreleased } from './changelog.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

const RELEASED = '## 0.9.0 - 2026-01-01\n\n### Added\n\n- old (#1)\n';
function doc(unreleased: string, released = RELEASED): string {
  return `# Changelog\n\nIntro.\n\n## Unreleased\n\n${unreleased}\n${released}`;
}
function text(result: ReturnType<typeof mergeChangelogUnreleased>): string {
  if (!result.ok) throw new Error(result.reason);
  return result.text;
}

describe('mergeChangelogUnreleased', () => {
  it("keeps main's entry then the PR's entry in the same Unreleased subsection", () => {
    const base = doc('### Added\n\n- base (#2)\n');
    const out = text(
      mergeChangelogUnreleased(
        base,
        doc('### Added\n\n- base (#2)\n- pr (#4)\n'),
        doc('### Added\n\n- base (#2)\n- main (#3)\n'),
      ),
    );
    expect(out).toBe(doc('### Added\n\n- base (#2)\n- main (#3)\n- pr (#4)\n'));
  });

  it('keeps entries the PR and main added under different subsections', () => {
    const base = doc('### Added\n\n- base (#2)\n');
    const out = text(
      mergeChangelogUnreleased(
        base,
        doc('### Added\n\n- base (#2)\n- pr (#4)\n'),
        doc('### Added\n\n- base (#2)\n\n### Changed\n\n- main (#3)\n'),
      ),
    );
    expect(out).toBe(doc('### Added\n\n- base (#2)\n- pr (#4)\n\n### Changed\n\n- main (#3)\n'));
    const created = text(
      mergeChangelogUnreleased(
        base,
        doc('### Added\n\n- base (#2)\n\n### Fixed\n\n- pr (#4)\n'),
        doc('### Added\n\n- base (#2)\n- main (#3)\n'),
      ),
    );
    expect(created).toBe(doc('### Added\n\n- base (#2)\n- main (#3)\n\n### Fixed\n\n- pr (#4)\n'));
  });

  it('refuses a change outside Unreleased on both sides', () => {
    const base = doc('### Added\n\n- base (#2)\n');
    const result = mergeChangelogUnreleased(
      base,
      doc('### Added\n\n- base (#2)\n', RELEASED.replace('old', 'pr edit')),
      doc('### Added\n\n- base (#2)\n- main (#3)\n', RELEASED.replace('old', 'main edit')),
    );
    expect(result).toEqual({ ok: false, reason: 'PR changed CHANGELOG.md outside ## Unreleased' });
  });

  it('refuses when the PR removed an existing Unreleased line', () => {
    const base = doc('### Added\n\n- base (#2)\n');
    const result = mergeChangelogUnreleased(base, doc('### Added\n\n- pr (#4)\n'), base);
    expect(result).toEqual({ ok: false, reason: 'PR removed or edited an existing Unreleased line' });
    const gone = mergeChangelogUnreleased(base, doc(''), base);
    expect(gone.ok).toBe(false);
  });

  it('refuses when a text has no Unreleased section', () => {
    const base = doc('### Added\n\n- base (#2)\n');
    expect(mergeChangelogUnreleased(base, base, RELEASED)).toEqual({
      ok: false,
      reason: 'no ## Unreleased section',
    });
  });

  it('never drops or reorders a line from main', () => {
    const base = doc('### Added\n\n- a\n');
    const theirs = doc('### Added\n\n- a\n- m1\n- m2\n\n### Changed\n\n- c\n');
    const out = text(mergeChangelogUnreleased(base, doc('### Added\n\n- a\n- p1\n'), theirs));
    const outLines = out.split('\n');
    let from = 0;
    for (const line of theirs.split('\n')) {
      const at = outLines.indexOf(line, from);
      expect(at).toBeGreaterThanOrEqual(from);
      from = at + 1;
    }
    expect(outLines.length).toBe(theirs.split('\n').length + 1);
  });

  it('moves PR additions into the new Unreleased after main promoted a release', () => {
    const base = doc('### Added\n\n- x (#2)\n');
    const theirs = `# Changelog\n\nIntro.\n\n## Unreleased\n\n## 1.0.0 - 2026-02-01\n\n### Added\n\n- x (#2)\n\n${RELEASED}`;
    const out = text(mergeChangelogUnreleased(base, doc('### Added\n\n- x (#2)\n- y (#4)\n'), theirs));
    expect(out).toBe(
      `# Changelog\n\nIntro.\n\n## Unreleased\n\n### Added\n\n- y (#4)\n\n## 1.0.0 - 2026-02-01\n\n### Added\n\n- x (#2)\n\n${RELEASED}`,
    );
  });

  it('skips a PR line main already has', () => {
    const base = doc('### Added\n\n- a\n');
    const theirs = doc('### Added\n\n- a\n- same\n');
    expect(text(mergeChangelogUnreleased(base, doc('### Added\n\n- a\n- same\n'), theirs))).toBe(theirs);
  });

  it('local git merge with the repo .gitattributes unions Unreleased additions without conflict markers', () => {
    const repo = tempDirs.makeSync('changelog-union-');
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Factory Test');
    git('config', 'user.email', 'factory@example.test');
    copyFileSync(join(process.cwd(), '.gitattributes'), join(repo, '.gitattributes'));
    writeFileSync(join(repo, 'CHANGELOG.md'), doc('### Added\n\n- base\n'));
    git('add', '.');
    git('commit', '-m', 'base');
    git('checkout', '-b', 'topic');
    const file = join(repo, 'CHANGELOG.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('- base\n', '- base\n- pr line\n'));
    git('commit', '-am', 'pr');
    git('checkout', 'main');
    writeFileSync(file, readFileSync(file, 'utf8').replace('- base\n', '- base\n- main line\n'));
    git('commit', '-am', 'main');
    git('checkout', 'topic');
    git('merge', '--no-edit', 'main');
    const merged = readFileSync(file, 'utf8');
    expect(merged).not.toContain('<<<<<<<');
    expect(merged).toContain('- pr line');
    expect(merged).toContain('- main line');
  });
});
