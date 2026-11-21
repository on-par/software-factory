import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempWorktrees } from '../test-support/temp-worktree.js';
import { accessibilityChecker, type CheckerContext, linksChecker } from './index.js';

const { makeWorktree, cleanup } = createTempWorktrees('checker-html-ignore-test-');

afterEach(async () => {
  await cleanup();
});

function makeContext(worktree: string): CheckerContext {
  return {
    worktree,
    specPath: join(worktree, 'no-such-spec.md'),
    constitutionBody: 'test constitution',
  };
}

describe('links and accessibility checkers honour checkers.html.ignore', () => {
  const placeholderPage = '<html><body><a href="#">todo</a></body></html>';
  const htmlIgnoreConfig = (ignore: string[]) => ({
    '.factory/config.json': JSON.stringify({ version: 2, checkers: { html: { ignore } } }),
  });

  it('skips HTML under docs/ by default and reports how many files it ignored', async () => {
    const worktree = await makeWorktree({ 'docs/mock.html': placeholderPage });

    const links = await linksChecker(makeContext(worktree));
    const accessibility = await accessibilityChecker(makeContext(worktree));

    expect(links.result).toBe('PASS');
    expect(links.details).toContain('1 HTML file ignored');
    expect(links.details).toContain('checkers.html.ignore');
    expect(accessibility.result).toBe('PASS');
    expect(accessibility.details).toContain('1 HTML file ignored');
    expect(accessibility.details).toContain('checkers.html.ignore');
  });

  it('scans docs/ again when the repo sets the ignore list to []', async () => {
    const worktree = await makeWorktree({ 'docs/mock.html': placeholderPage, ...htmlIgnoreConfig([]) });

    const links = await linksChecker(makeContext(worktree));
    const accessibility = await accessibilityChecker(makeContext(worktree));

    expect(links.result).toBe('FAIL');
    expect(links.details).toContain('docs/mock.html');
    expect(links.details).not.toContain('ignored');
    expect(accessibility.result).toBe('FAIL');
    expect(accessibility.details).toContain('docs/mock.html: 1 placeholder links');
    expect(accessibility.details).not.toContain('ignored');
  });

  it('still fails a placeholder link outside docs/ with the default ignore list', async () => {
    const worktree = await makeWorktree({ 'docs/mock.html': placeholderPage, 'src/page.html': placeholderPage });

    const links = await linksChecker(makeContext(worktree));
    const accessibility = await accessibilityChecker(makeContext(worktree));

    expect(links.result).toBe('FAIL');
    expect(links.broken).toBe(1);
    expect(links.details).toContain('src/page.html');
    expect(links.details).not.toContain('docs/mock.html');
    expect(links.details).toContain('1 HTML file ignored');
    expect(accessibility.result).toBe('FAIL');
    expect(accessibility.details).toContain('src/page.html: 1 placeholder links');
    expect(accessibility.details).not.toContain('docs/mock.html');
    expect(accessibility.details).toContain('1 HTML file ignored');
  });

  it('replaces the default with an explicit list, so design/** is skipped and docs/ is scanned', async () => {
    const worktree = await makeWorktree({
      'design/a.html': placeholderPage,
      'docs/b.html': placeholderPage,
      ...htmlIgnoreConfig(['design/**']),
    });

    const links = await linksChecker(makeContext(worktree));
    const accessibility = await accessibilityChecker(makeContext(worktree));

    expect(links.result).toBe('FAIL');
    expect(links.broken).toBe(1);
    expect(links.details).toContain('docs/b.html');
    expect(links.details).not.toContain('design/a.html');
    expect(links.details).toContain('1 HTML file ignored');
    expect(accessibility.result).toBe('FAIL');
    expect(accessibility.details).toContain('docs/b.html: 1 placeholder links');
    expect(accessibility.details).not.toContain('design/a.html');
    expect(accessibility.details).toContain('1 HTML file ignored');
  });

  it('takes the ignore list passed to CHECK over the repo config file', async () => {
    const worktree = await makeWorktree({ 'docs/mock.html': placeholderPage, ...htmlIgnoreConfig(['docs/**']) });
    const ctx: CheckerContext = { ...makeContext(worktree), checkersConfig: { html: { ignore: [] } } };

    const links = await linksChecker(ctx);
    const accessibility = await accessibilityChecker(ctx);

    expect(links.result).toBe('FAIL');
    expect(accessibility.result).toBe('FAIL');
  });
});
