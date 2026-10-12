import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFactoryPaths } from '@on-par/factory-core';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const READMES = ['README.md', 'packages/cli/README.md'];
const FAKE_REPO = '/repo';

const SCAFFOLD = [
  '.factory/',
  '.factory/config.yaml',
  '.factory/config.json',
  '.factory/constitution.md',
  '.factory/.gitignore',
  '.factory/state/',
];

function allowedPaths(): Set<string> {
  const allowed = new Set<string>(SCAFFOLD);
  const paths = getFactoryPaths(FAKE_REPO, undefined, {});
  for (const v of Object.values(paths)) {
    if (typeof v !== 'string') continue;
    const rel = relative(FAKE_REPO, v).split('\\').join('/');
    if (!rel.startsWith('.factory')) continue;
    allowed.add(rel);
    allowed.add(`${rel}/`);
  }
  return allowed;
}

function extract(text: string): string[] {
  const re = /(?<![~\w/.])\.factory\/[\w.\-/]*/g;
  return (text.match(re) ?? []).map((p) => p.replace(/[.,]+$/, ''));
}

const read = (file: string): string => readFileSync(join(repoRoot, file), 'utf8');

describe('README .factory paths', () => {
  it('every repo-relative .factory path in README.md and packages/cli/README.md resolves to getFactoryPaths or the init scaffold', () => {
    const allowed = allowedPaths();
    const offenders: string[] = [];
    for (const file of READMES) {
      for (const p of extract(read(file))) {
        if (!allowed.has(p)) offenders.push(`${file}: ${p}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('README.md and packages/cli/README.md do not call worktrees a sibling of the repo', () => {
    for (const file of READMES) {
      expect(read(file)).not.toContain('sibling of your repo');
    }
    expect(read('README.md')).toContain('~/.factory/worktrees/<owner>/<repo>/');
  });

  it('finds at least one .factory path in README.md', () => {
    expect(extract(read('README.md')).length).toBeGreaterThan(0);
  });
});

describe('CLI README provider setup pointer', () => {
  const cliReadme = read('packages/cli/README.md');
  const start = cliReadme.indexOf('Also requires');
  const end = cliReadme.indexOf('## Safety', start);
  const prereqs = start >= 0 && end > start ? cliReadme.slice(start, end) : '';
  const links = [...prereqs.matchAll(/\]\(([^)\s]*agents\.md)\)/g)].map((m) => m[1]);
  const PREFIX = 'https://github.com/on-par/software-factory/blob/main/';

  it('prerequisites have exactly one link to the provider setup guide', () => {
    expect(prereqs).not.toBe('');
    expect(links).toEqual([`${PREFIX}docs/agents.md`]);
    expect(prereqs).not.toMatch(/^#{2,} /m);
  });

  it('the provider setup link resolves to an existing file in the repo', () => {
    const target = links[0] ?? '';
    expect(target.startsWith(PREFIX)).toBe(true);
    expect(existsSync(join(repoRoot, target.slice(PREFIX.length)))).toBe(true);
  });
});
