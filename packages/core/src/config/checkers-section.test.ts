import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { DEFAULT_HTML_IGNORE, resolveHtmlIgnore } from './checkers-section.js';
import { loadRepoConfig, RepoFactoryConfigV2Schema } from './repo.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

function repo(config: unknown): string {
  const root = tmp.makeSync('repo-checkers-');
  mkdirSync(join(root, '.factory'));
  writeFileSync(join(root, '.factory', 'config.json'), JSON.stringify(config));
  return root;
}

describe('checkers.html.ignore', () => {
  it('defaults to docs/** when the repo config leaves it unset', () => {
    expect(DEFAULT_HTML_IGNORE).toEqual(['docs/**']);
    expect(resolveHtmlIgnore(undefined)).toEqual(['docs/**']);
    expect(resolveHtmlIgnore(loadRepoConfig(repo({ version: 2 }))?.checkers)).toEqual(['docs/**']);
    const parsed = RepoFactoryConfigV2Schema.parse({ version: 2, checkers: { html: {} } });
    expect(parsed.checkers?.html?.ignore).toEqual(['docs/**']);
  });

  it('keeps an explicit list, including [] to scan every HTML file', () => {
    const ignoreOf = (ignore: string[]) =>
      resolveHtmlIgnore(loadRepoConfig(repo({ version: 2, checkers: { html: { ignore } } }))?.checkers);

    expect(ignoreOf([])).toEqual([]);
    expect(ignoreOf(['design/**', 'reference/'])).toEqual(['design/**', 'reference/']);
  });

  it('rejects a non-array, non-string or empty entries, and unknown keys', () => {
    for (const bad of [
      { html: { ignore: 'docs/**' } },
      { html: { ignore: [7] } },
      { html: { ignore: [''] } },
      { html: { ignore: null } },
      { html: { bogus: [] } },
      { css: {} },
    ]) {
      expect(RepoFactoryConfigV2Schema.safeParse({ version: 2, checkers: bad }).success).toBe(false);
    }
    expect(() => loadRepoConfig(repo({ version: 2, checkers: { html: { ignore: 'docs' } } }))).toThrow(
      /checkers\.html\.ignore/,
    );
  });
});
