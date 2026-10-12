import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
// The override lets the guard run against an older README, e.g. `git show 54fe502:README.md`.
const readmePath = process.env.FACTORY_README_PATH
  ? resolve(process.cwd(), process.env.FACTORY_README_PATH)
  : join(repoRoot, 'README.md');
const readme = readFileSync(readmePath, 'utf8');

function section(text: string, startMarker: string, endMarker: string): string | undefined {
  const start = text.indexOf(startMarker);
  if (start < 0) return undefined;
  const end = text.indexOf(endMarker, start);
  if (end <= start) return undefined;
  return text.slice(start, end);
}

function codeBlocks(text: string): string[] {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
}

function commands(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.split('#')[0]?.trim() ?? '')
    .filter((line) => line.length > 0);
}

function quickStartProblems(text: string): string[] {
  const problems: string[] = [];

  const quickStart = section(text, '## Quick start', '## Configuration');
  if (quickStart === undefined) {
    problems.push('missing Quick start section');
  } else if (codeBlocks(quickStart).some((b) => b.includes('factory constitution --product'))) {
    problems.push('Quick start code block contains factory constitution --product');
  }

  const step3 = section(text, '**Step 3', '**Step 4');
  if (step3 === undefined) {
    problems.push('missing Step 3');
  } else {
    const cmds = codeBlocks(step3).flatMap(commands);
    const expected = ['factory constitution --list', 'factory constitution --checkers'];
    if (JSON.stringify(cmds) !== JSON.stringify(expected)) {
      problems.push(`Step 3 code block runs ${JSON.stringify(cmds)}, expected only --list and --checkers`);
    }
    if (!step3.includes('For a code repo, skip this step')) {
      problems.push('Step 3 does not say For a code repo, skip this step');
    }
  }

  const prereqs = section(text, '**Prerequisites**', '**Step 3');
  if (prereqs === undefined) {
    problems.push('missing Prerequisites before Step 3');
  } else {
    if (!/^- \*\*Constitution\*\*: /m.test(prereqs)) {
      problems.push('Constitution is not defined before Step 3');
    }
    if (!/^- \*\*Triage\*\*: /m.test(prereqs)) {
      problems.push('Triage is not defined before Step 3');
    }
  }

  return problems;
}

const FENCE = '```';

// Trimmed copy of the Quick start as of 54fe502.
const OLD_QUICK_START = [
  '## Quick start',
  '',
  '**Prerequisites**',
  '',
  '- Node.js 20 or newer',
  '- The `gh` CLI, signed in',
  '',
  '**Step 2: Initialize your repo**',
  '',
  `${FENCE}bash`,
  'factory init',
  FENCE,
  '',
  '**Step 3 (optional): Pick a different constitution**',
  '',
  `${FENCE}bash`,
  'factory constitution --list',
  'factory constitution --checkers',
  'factory constitution --product example-marketing-site',
  FENCE,
  '',
  'The `default-code` scaffold works as is.',
  '',
  '**Step 4: Triage the backlog**',
  '',
  '## Configuration',
  '',
].join('\n');

const messageIncludes = (problems: string[], part: string): string[] => problems.filter((p) => p.includes(part));

describe('README Quick start constitution step', () => {
  const problems = quickStartProblems(readme);

  it('no Quick start code block contains factory constitution --product', () => {
    expect(messageIncludes(problems, '--product')).toEqual([]);
  });

  it('README Step 3 code block runs only read-only constitution commands (--list, --checkers)', () => {
    expect(messageIncludes(problems, 'Step 3 code block runs')).toEqual([]);
    expect(messageIncludes(problems, 'missing Step 3')).toEqual([]);
  });

  it('README Step 3 says For a code repo, skip this step', () => {
    expect(messageIncludes(problems, 'skip this step')).toEqual([]);
  });

  it('README Prerequisites defines constitution and triage before Step 3', () => {
    expect(messageIncludes(problems, 'before Step 3')).toEqual([]);
  });

  it('README has no Quick start problems', () => {
    expect(quickStartProblems(readme)).toEqual([]);
  });
});

describe('README Quick start guard self-test', () => {
  it('rejects the 54fe502 Quick start (constitution --product block and undefined constitution)', () => {
    const problems = quickStartProblems(OLD_QUICK_START);
    expect(messageIncludes(problems, '--product')).toHaveLength(2);
    expect(messageIncludes(problems, 'Step 3 code block runs')).toHaveLength(1);
    expect(problems).toContain('Step 3 does not say For a code repo, skip this step');
    expect(problems).toContain('Constitution is not defined before Step 3');
  });

  it('reports missing sections instead of passing on an empty README', () => {
    expect(quickStartProblems('')).toContain('missing Quick start section');
  });
});

describe('README provider setup pointer', () => {
  const prereqs = section(readme, '**Prerequisites**', 'Two terms used in the steps below') ?? '';
  const links = [...prereqs.matchAll(/\]\(([^)\s]*agents\.md)\)/g)].map((m) => m[1]);

  it('Prerequisites has exactly one link to docs/agents.md', () => {
    expect(prereqs).not.toBe('');
    expect(links).toEqual(['docs/agents.md']);
  });

  it('the docs/agents.md link target exists in the repo', () => {
    expect(existsSync(join(repoRoot, 'docs', 'agents.md'))).toBe(true);
  });
});
