import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

describe('agents-layout', () => {
  it('AGENTS.md copies no coverage numbers and names vitest.config.ts as their source', () => {
    const agents = read('AGENTS.md');
    expect(agents).not.toContain('94, functions 91');
    expect(agents).not.toMatch(/\b(lines|statements|functions|branches)\s+\d{2}\b/i);
    expect(agents).toContain('vitest.config.ts');
  });

  it('README Monorepo structure tree lists every packages/ directory', () => {
    const packagesDir = resolve(REPO_ROOT, 'packages');
    const names = readdirSync(packagesDir).filter(
      (name) =>
        statSync(resolve(packagesDir, name)).isDirectory() && existsSync(resolve(packagesDir, name, 'package.json')),
    );
    const readme = read('README.md');
    const start = readme.indexOf('## Monorepo structure');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = readme.slice(start + 1);
    const next = rest.indexOf('\n## ');
    const section = next === -1 ? rest : rest.slice(0, next);
    const fence = /```[^\n]*\n([\s\S]*?)```/.exec(section);
    expect(fence).not.toBeNull();
    const tree = fence?.[1] ?? '';
    const missing = names.filter((name) => !new RegExp(`[├└]── ${name}/`).test(tree));
    expect(missing).toEqual([]);
  });

  it('README and docs/status.md do not deny the server pause endpoint', () => {
    const readme = read('README.md');
    const status = read('docs/status.md');
    expect(readme).not.toContain('only route is');
    expect(status).not.toContain('no control endpoints');
    expect(readme).toContain('/pause');
    expect(status).toContain('/pause');
  });

  it('server README has no stale Phase 2 (planned) roadmap', () => {
    expect(read('packages/server/README.md')).not.toContain('Phase 2 (planned)');
  });
});
