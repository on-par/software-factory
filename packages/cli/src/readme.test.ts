import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The overrides let the guard run against older READMEs, e.g. `git show v0.9.3:README.md`.
const readFrom = (envVar: string, file: string): string =>
  readFileSync(process.env[envVar] ? resolve(process.cwd(), process.env[envVar]) : join(repoRoot, file), 'utf8');
const rootReadme = readFrom('FACTORY_README_PATH', 'README.md');
const cliReadme = readFrom('FACTORY_CLI_README_PATH', 'packages/cli/README.md');

const GUIDE = 'docs/agents.md';
const CLI_PREFIX = 'https://github.com/on-par/software-factory/blob/main/';
type ReadmeKind = 'root' | 'cli';

function rootPrerequisites(text: string): string | undefined {
  const marker = text.indexOf('**Prerequisites**');
  if (marker < 0) return undefined;
  const lines = text.slice(marker).split('\n').slice(1);
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++;
  const list: string[] = [];
  while (i < lines.length && (lines[i] ?? '').startsWith('- ')) list.push(lines[i++] ?? '');
  return list.length > 0 ? list.join('\n') : undefined;
}

function cliPrerequisites(text: string): string | undefined {
  const start = text.indexOf('Also requires');
  if (start < 0) return undefined;
  const end = text.indexOf('## Safety', start);
  if (end < 0) return undefined;
  const block = text.slice(start, end);
  return /^#{2,} /m.test(block) ? undefined : block;
}

const providerGuideLinks = (block: string): string[] =>
  [...block.matchAll(/\]\(([^)\s]*agents\.md)\)/g)].map((m) => m[1] ?? '');

function providerGuideProblems(text: string, kind: ReadmeKind, exists: (repoPath: string) => boolean): string[] {
  const section = kind === 'root' ? rootPrerequisites(text) : cliPrerequisites(text);
  if (section === undefined) return ['missing prerequisites section'];
  const links = providerGuideLinks(section);
  if (links.length === 0) return ['no provider setup guide link in prerequisites'];
  if (links.length > 1) {
    return [`expected exactly one provider setup guide link, found ${links.length}`];
  }
  const link = links[0] ?? '';
  const expected = kind === 'root' ? GUIDE : CLI_PREFIX + GUIDE;
  if (link !== expected) {
    return [`provider setup guide link is ${link}, expected ${expected}`];
  }
  const repoPath = kind === 'root' ? link : link.slice(CLI_PREFIX.length);
  return exists(repoPath) ? [] : [`provider setup guide link target ${repoPath} does not exist`];
}

const inRepo = (p: string): boolean => existsSync(join(repoRoot, p));

describe('README provider setup guide pointer', () => {
  it('README.md Prerequisites has exactly one provider setup guide link and its target exists', () => {
    expect(providerGuideProblems(rootReadme, 'root', inRepo)).toEqual([]);
  });

  it('packages/cli/README.md prerequisites have exactly one provider setup guide link and its target exists', () => {
    expect(providerGuideProblems(cliReadme, 'cli', inRepo)).toEqual([]);
  });

  it('README.md and packages/cli/README.md each have exactly one provider setup guide link whose target exists', () => {
    expect({
      root: providerGuideProblems(rootReadme, 'root', inRepo),
      cli: providerGuideProblems(cliReadme, 'cli', inRepo),
    }).toEqual({ root: [], cli: [] });
  });
});

const V093_ROOT = [
  '**Prerequisites**',
  '',
  '- Node.js ≥ 24 (the `engines.node` field in `packages/cli/package.json`)',
  '- `git`',
  '- Claude Code (`claude`) installed, on your PATH, and signed in. The TRIAGE phase shells out to `claude -p`, and Claude models in every tier run through it.',
  '- The GitHub CLI `gh`, signed in with `gh auth login`. The factory uses `gh repo view` to detect your repo.',
  '- A GitHub token. The factory reads `GITHUB_TOKEN`, then `GH_TOKEN`, and falls back to `gh auth token` when neither is set, so `gh auth login` is usually enough.',
  '- Optional: the OpenAI Codex CLI (`codex`) for worker builds, and `ollama` for experimental local models.',
  '',
  'Run `factory doctor` after installing (Step 1) to check all of this.',
  '',
].join('\n');

const V093_CLI = [
  'Also requires `git`, Claude Code (`claude`) installed and signed in, and the GitHub CLI signed in with `gh auth login`. The factory reads `GITHUB_TOKEN`, then `GH_TOKEN`, and falls back to `gh auth token`. `factory doctor` checks all of this and prints a fix for anything missing.',
  '',
  '`factory init` creates a local-only `.factory/` (git-excluded) with a `default-code` constitution. See the main README quick start.',
  '',
  '## Safety',
  '',
].join('\n');

describe('README provider setup guide guard self-test', () => {
  it('rejects the 0.9.3 root and CLI prerequisites with no provider setup guide link', () => {
    const none = ['no provider setup guide link in prerequisites'];
    expect(providerGuideProblems(V093_ROOT, 'root', () => true)).toEqual(none);
    expect(providerGuideProblems(V093_CLI, 'cli', () => true)).toEqual(none);
  });

  it('rejects two provider setup guide links', () => {
    const root = `${V093_ROOT.replace('Run `factory doctor`', '')}`.replace(
      '- `git`',
      '- `git` ([setup](docs/agents.md), [again](docs/agents.md))',
    );
    expect(providerGuideProblems(root, 'root', () => true)).toEqual([
      'expected exactly one provider setup guide link, found 2',
    ]);
  });

  it('rejects a link whose target does not exist', () => {
    const root = V093_ROOT.replace('- `git`', '- `git` ([setup](docs/agents.md))');
    const cli = V093_CLI.replace('`gh auth login`.', `[setup](${CLI_PREFIX}${GUIDE}).`);
    expect(providerGuideProblems(root, 'root', () => false)).toEqual([
      'provider setup guide link target docs/agents.md does not exist',
    ]);
    expect(providerGuideProblems(cli, 'cli', () => false)).toEqual([
      'provider setup guide link target docs/agents.md does not exist',
    ]);
  });

  it('reports a missing section instead of passing on an empty README', () => {
    expect(providerGuideProblems('', 'root', () => true)).toEqual(['missing prerequisites section']);
    expect(providerGuideProblems('', 'cli', () => true)).toEqual(['missing prerequisites section']);
  });
});

describe('README agent-neutral prerequisites', () => {
  it('README.md and packages/cli/README.md prerequisites say one supported coding agent CLI and do not name claude, and doctor descriptions do not name claude', () => {
    const problems: string[] = [];
    const root = rootPrerequisites(rootReadme) ?? '';
    const cli = cliPrerequisites(cliReadme) ?? '';
    if (!root.toLowerCase().includes('one supported coding agent cli (see [docs/agents.md](docs/agents.md))')) {
      problems.push('root prerequisites lack the agent-neutral bullet');
    }
    if (!cli.includes(`one supported coding agent CLI (see [docs/agents.md](${CLI_PREFIX}${GUIDE}))`)) {
      problems.push('cli prerequisites lack the agent-neutral sentence');
    }
    if (/`claude`|Claude Code/.test(root)) problems.push('root prerequisites name claude');
    if (/`claude`|Claude Code/.test(cli)) problems.push('cli prerequisites name claude');
    const doctorLines = rootReadme
      .split('\n')
      .filter((line) => /^factory doctor\s+Check/.test(line) || line.includes('`factory doctor` checks'));
    if (doctorLines.length < 2) problems.push(`expected 2 doctor descriptions, found ${doctorLines.length}`);
    for (const line of doctorLines) {
      if (/\bclaude\b/i.test(line)) problems.push(`doctor description names claude: ${line.slice(0, 60)}`);
    }
    expect(problems).toEqual([]);
  });

  it('docs/models.md and docs/status.md each link to agents.md and the target exists', () => {
    const docsDir = join(repoRoot, 'docs');
    for (const file of ['docs/models.md', 'docs/status.md']) {
      const text = readFileSync(join(repoRoot, file), 'utf8');
      const targets = [...text.matchAll(/\]\(([^)\s]*agents\.md)\)/g)].map((m) => m[1] as string);
      expect(targets.length, `${file} links agents.md`).toBeGreaterThan(0);
      for (const target of targets) {
        const resolved = resolve(docsDir, target);
        expect(resolved, `${file} -> ${target}`).toBe(join(repoRoot, 'docs/agents.md'));
        expect(existsSync(resolved)).toBe(true);
      }
    }
  });
});
