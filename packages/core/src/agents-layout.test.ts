import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function missingLayoutEntries(
  agentsText: string,
  names: readonly string[],
  format: (name: string) => string,
): string[] {
  return names.filter((name) => !agentsText.includes(format(name)));
}

const agentsText = readFileSync(fileURLToPath(new URL('../../../AGENTS.md', import.meta.url)), 'utf8');
const packages = readdirSync(fileURLToPath(new URL('../../../packages/', import.meta.url)), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const coreModules = readdirSync(fileURLToPath(new URL('./', import.meta.url)), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('__'))
  .map((entry) => entry.name);
const repositoryLayout = agentsText.match(/## Repository layout\n\n```[\s\S]*?```/)?.[0] ?? '';
const coreModuleInventory =
  agentsText.match(/### What lives in `packages\/core\/src`\n([\s\S]*?)\n## Key commands/)?.[1] ?? '';

describe('AGENTS.md repository layout', () => {
  it('reports an omitted package in input order', () => {
    const fixture = packages
      .filter((name) => name !== 'tui')
      .map((name) => `${name}/`)
      .join('\n');

    expect(missingLayoutEntries(fixture, packages, (name) => `${name}/`)).toEqual(['tui']);
  });

  it.each(packages)('documents package %s/', (pkg) => {
    expect(missingLayoutEntries(repositoryLayout, packages, (name) => `${name}/`)).not.toContain(pkg);
  });
});

describe('AGENTS.md core-module inventory', () => {
  it.each(coreModules)('documents core module `%s/`', (module) => {
    expect(missingLayoutEntries(coreModuleInventory, coreModules, (name) => `\`${name}/\``)).not.toContain(module);
  });
});
