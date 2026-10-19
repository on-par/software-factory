import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { main } from './cli/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The overrides let the guard run against older READMEs, e.g. `git show v0.9.3:README.md`.
const readFrom = (envVar: string, file: string): string =>
  readFileSync(process.env[envVar] ? resolve(process.cwd(), process.env[envVar]) : join(repoRoot, file), 'utf8');
const rootReadme = readFrom('FACTORY_README_PATH', 'README.md');
const cliReadme = readFrom('FACTORY_CLI_README_PATH', 'packages/cli/README.md');

const GUIDE = 'docs/agents.md';
const CLI_PREFIX = 'https://github.com/on-par/software-factory/blob/main/';
type ReadmeKind = 'root' | 'cli';

function noCiWaitProblems(text: string): string[] {
  const problems: string[] = [];
  if (!text.includes('no checks reported yet counts as pending')) {
    problems.push('missing "no checks reported yet counts as pending" sentence');
  }
  if (text.includes('logs `no CI checks found`')) problems.push('still claims SHIP logs `no CI checks found`');
  return problems;
}

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
    const root = V093_ROOT.replace('Run `factory doctor`', '').replace(
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

class HelpExit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

// Commander prints help and then calls process.exit, so stub exit to throw and capture stdout.
async function helpOutput(...args: string[]): Promise<string> {
  const chunks: string[] = [];
  const realWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new HelpExit(code ?? 0);
  }) as never);
  try {
    await main(['node', 'factory', ...args]);
  } catch (err) {
    if (!(err instanceof HelpExit)) throw err;
  } finally {
    process.stdout.write = realWrite;
    exitSpy.mockRestore();
    process.exitCode = undefined;
  }
  return chunks.join('').replace(/\s+/g, ' ');
}

describe('factory --help queue path', () => {
  it('root --help names .factory/state/queue.proposed and never .factory/queue.proposed', async () => {
    const text = await helpOutput('--help');
    expect(text).toContain('.factory/state/queue.proposed');
    expect(text).not.toContain('.factory/queue.proposed');
  });

  it('triage --help names .factory/state/queue.proposed and .factory/state/queue', async () => {
    const text = await helpOutput('triage', '--help');
    expect(text).toContain('.factory/state/queue.proposed');
    expect(text).not.toContain('.factory/queue.proposed');
    expect(text).toMatch(/\.factory\/state\/queue\b(?!\.)/);
  });
});

function section(text: string, heading: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === heading);
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return [heading, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

function updatingProblems(text: string): string[] {
  const block = section(text, '## Updating');
  if (block === undefined) return ['missing Updating section'];
  const problems: string[] = [];
  if (block.includes('0.9.0')) problems.push('Updating names 0.9.0');
  if (!block.includes('self-update --check')) problems.push('Updating does not mention self-update --check');
  if (!block.includes('0.9.3')) problems.push('Updating does not say 0.9.3');
  return problems;
}

function linuxFirejailProblems(block: string | undefined): string[] {
  if (block === undefined) return ['missing section'];
  const ok = block
    .split(/\n\s*\n/)
    .some((p) => /Linux/.test(p) && /install `?firejail`?/i.test(p) && /workspace-write/.test(p));
  return ok ? [] : ['no Linux firejail install step with the workspace-write fallback'];
}

const gitIdentityProblems = (text: string): string[] =>
  text.includes('repo-local `git config`') ? [] : ['git identity text does not say repo-local git config works'];

describe('README update and setup text', () => {
  it('Updating sections name no stale release and say self-update --check works in 0.9.3', () => {
    expect({ root: updatingProblems(rootReadme), cli: updatingProblems(cliReadme) }).toEqual({ root: [], cli: [] });
  });

  it('Linux Quick start says to install firejail first and why', () => {
    expect(linuxFirejailProblems(section(rootReadme, '## Quick start'))).toEqual([]);
    expect(linuxFirejailProblems(section(cliReadme, '## Install'))).toEqual([]);
  });

  it('git identity text says repo-local git config works too', () => {
    expect({ root: gitIdentityProblems(rootReadme), cli: gitIdentityProblems(cliReadme) }).toEqual({
      root: [],
      cli: [],
    });
  });
});

describe('README update and setup guard self-test', () => {
  it('rejects the pre-fix root Updating text', () => {
    const old =
      '## Updating\n\nAutomatic updates are planned: #2354, #2355. The version check (`factory self-update --check`, #2354) is merged on `main` but is not in the 0.9.0 release on npm.\n';
    expect(updatingProblems(old)).toContain('Updating names 0.9.0');
  });

  it('rejects the pre-fix CLI Updating text', () => {
    const old = '## Updating\n\nAutomatic updates are planned: [#2354](https://example.com/2354).\n';
    expect(updatingProblems(old)).toEqual([
      'Updating does not mention self-update --check',
      'Updating does not say 0.9.3',
    ]);
  });

  it('is not fooled by the pre-existing firejail mentions', () => {
    const old = [
      '## Quick start',
      '',
      'Safety: the factory uses `firejail` on Linux and install its dependencies first.',
      '',
      '- Codex runs with `--sandbox workspace-write` when no OS sandbox is available.',
    ].join('\n');
    expect(linuxFirejailProblems(old)).toEqual(['no Linux firejail install step with the workspace-write fallback']);
  });

  it('reports missing sections', () => {
    expect(updatingProblems('')).toEqual(['missing Updating section']);
    expect(linuxFirejailProblems(section('', '## Quick start'))).toEqual(['missing section']);
    expect(gitIdentityProblems('')).toHaveLength(1);
  });
});

const OLD_WORDING = [
  'Older Node versions are refused with a clear message.',
  'So `.factory/` is local to this clone',
  'use it only on purpose',
  'running a Sound Buddy lane',
];
const NEW_ROOT_WORDING = [
  'On older Node versions, the CLI stops and tells you which version it needs.',
  "That keeps `.factory/` local to this clone. It isn't committed, so copy it yourself if you work from another machine or clone.",
  'set it only when you mean to.',
  'running a lane on a real product repo (sped up)',
];
const GIF_ALT = 'running a lane on a real product repo (sped up)';

function wordingProblems(text: string, oldList: string[], newList: string[]): string[] {
  const problems: string[] = [];
  for (const old of oldList) if (text.includes(old)) problems.push(`still says: ${old}`);
  for (const want of newList) if (!text.includes(want)) problems.push(`missing: ${want}`);
  return problems;
}

describe('README wording', () => {
  it('Step 1 and Step 2 use the reworded Node and .factory/ text', () => {
    expect(wordingProblems(rootReadme, OLD_WORDING.slice(0, 2), NEW_ROOT_WORDING.slice(0, 2))).toEqual([]);
  });

  it('Safety and GIF alt text use the reworded text in both READMEs', () => {
    expect(wordingProblems(rootReadme, OLD_WORDING.slice(2), NEW_ROOT_WORDING.slice(2))).toEqual([]);
    expect(wordingProblems(cliReadme, OLD_WORDING, [GIF_ALT])).toEqual([]);
  });
});

describe('README wording guard self-test', () => {
  it('rejects the pre-fix wording', () => {
    const problems = wordingProblems(OLD_WORDING.join('\n'), OLD_WORDING, NEW_ROOT_WORDING);
    for (const old of OLD_WORDING) expect(problems).toContain(`still says: ${old}`);
    for (const want of NEW_ROOT_WORDING) expect(problems).toContain(`missing: ${want}`);
  });

  it('reports missing wording on an empty README', () => {
    expect(wordingProblems('', OLD_WORDING, [GIF_ALT])).toEqual([`missing: ${GIF_ALT}`]);
  });
});

const agentsGuide = readFileSync(join(repoRoot, GUIDE), 'utf8');

function supportedCodingAgents(guide: string): string[] {
  const lines = guide.split('\n');
  const start = lines.findIndex((l) => l === '## Harness matrix');
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  const agents: string[] = [];
  for (const line of end < 0 ? rest : rest.slice(0, end)) {
    if (!line.startsWith('|') || line.startsWith('| ---')) continue;
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c !== '');
    const agent = cells[0] ?? '';
    if (cells[cells.length - 1] === '`supported`' && lines.includes(`## ${agent}`)) agents.push(agent);
  }
  return agents;
}

function quickStartAgentParityProblems(readme: string, agents: string[]): string[] {
  const quickStart = section(readme, '## Quick start');
  if (quickStart === undefined) return ['missing Quick start section'];
  if (agents.length === 0) return ['no supported coding agents found in docs/agents.md'];
  const lines = quickStart.split('\n');
  const missing = agents.filter((a) => !lines.includes(`### Use ${a}`));
  return missing.length === agents.length ? [] : missing.map((a) => `missing ### Use ${a}`);
}

function claudeCodeSubsectionProblems(readme: string): string[] {
  const lines = (section(readme, '## Quick start') ?? '').split('\n');
  const start = lines.indexOf('### Use Claude Code');
  if (start < 0) return ['missing ### Use Claude Code'];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('### ') || l.startsWith('## '));
  const block = (end < 0 ? rest : rest.slice(0, end)).join('\n');
  return ['/login', 'ANTHROPIC_API_KEY', 'factory doctor', '](docs/agents.md)']
    .filter((needle) => !block.includes(needle))
    .map((needle) => `Use Claude Code does not mention ${needle}`);
}

describe('README Quick start agent parity', () => {
  it('every supported coding agent in docs/agents.md has a Use <Agent> Quick start subsection when any does', () => {
    const agents = supportedCodingAgents(agentsGuide);
    expect(agents).toEqual(expect.arrayContaining(['Claude Code', 'Codex']));
    expect(quickStartAgentParityProblems(rootReadme, agents)).toEqual([]);
  });

  it('Use Claude Code subsection names /login, ANTHROPIC_API_KEY, factory doctor and links docs/agents.md', () => {
    expect(claudeCodeSubsectionProblems(rootReadme)).toEqual([]);
  });
});

describe('README Quick start agent parity guard self-test', () => {
  const matrix = [
    '## Harness matrix',
    '',
    '| Agent | Harness id | Status |',
    '| --- | --- | --- |',
    '| Claude Code | `claude-cli` | `supported` |',
    '| Codex | `codex-cli` | `supported` |',
    '| OpenCode | `opencode` | `experimental` |',
    '| Declared custom harness | `command` | `supported` |',
    '',
    '## Claude Code',
    '## Codex',
    '## OpenCode',
  ].join('\n');

  it('reads Claude Code and Codex, not experimental or custom harness rows, from the matrix', () => {
    expect(supportedCodingAgents(matrix)).toEqual(['Claude Code', 'Codex']);
  });

  it('rejects a Quick start with Use Codex and no Use Claude Code', () => {
    const readme = '## Quick start\n\n### Use Codex\n\ntext\n\n## Configuration';
    expect(quickStartAgentParityProblems(readme, ['Claude Code', 'Codex'])).toEqual(['missing ### Use Claude Code']);
  });

  it('passes when no agent has a subsection, and reports a missing section or empty agent list', () => {
    expect(quickStartAgentParityProblems('## Quick start\n\ntext\n', ['Claude Code', 'Codex'])).toEqual([]);
    expect(quickStartAgentParityProblems('# Title', ['Codex'])).toEqual(['missing Quick start section']);
    expect(quickStartAgentParityProblems('## Quick start\n', [])).toEqual([
      'no supported coding agents found in docs/agents.md',
    ]);
  });

  it('rejects a Use Claude Code subsection with no login or doctor check', () => {
    const readme = '## Quick start\n\n### Use Claude Code\n\nInstall it.\n\n### Safety\n\n`/login`';
    expect(claudeCodeSubsectionProblems(readme)).toEqual([
      'Use Claude Code does not mention /login',
      'Use Claude Code does not mention ANTHROPIC_API_KEY',
      'Use Claude Code does not mention factory doctor',
      'Use Claude Code does not mention ](docs/agents.md)',
    ]);
    expect(claudeCodeSubsectionProblems('## Quick start\n')).toEqual(['missing ### Use Claude Code']);
  });
});

describe('README no-CI wait', () => {
  it('README.md says a PR with no checks yet counts as pending', () => {
    expect(noCiWaitProblems(rootReadme)).toEqual([]);
  });

  it('flags a missing sentence or the stale skip claim and accepts the new one', () => {
    expect(noCiWaitProblems('')).toHaveLength(1);
    expect(noCiWaitProblems('no checks reported yet counts as pending; it logs `no CI checks found`')).toHaveLength(1);
    expect(noCiWaitProblems('a PR with no checks reported yet counts as pending')).toEqual([]);
  });
});
