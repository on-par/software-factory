import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

function section(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  expect(start, `missing marker ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(endMarker, start);
  expect(end, `missing marker ${endMarker}`).toBeGreaterThan(start);
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

describe('README Quick start constitution step', () => {
  it('no Quick start code block contains factory constitution --product', () => {
    const quickStart = section(readme, '## Quick start', '## Configuration');
    for (const block of codeBlocks(quickStart)) {
      expect(block).not.toContain('factory constitution --product');
    }
  });

  it('README Step 3 code block runs only read-only constitution commands (--list, --checkers)', () => {
    const step3 = section(readme, '**Step 3', '**Step 4');
    const cmds = codeBlocks(step3).flatMap(commands);
    expect(cmds).toEqual(['factory constitution --list', 'factory constitution --checkers']);
  });

  it('README Step 3 says For a code repo, skip this step', () => {
    const step3 = section(readme, '**Step 3', '**Step 4');
    expect(step3).toContain('For a code repo, skip this step');
  });
});
