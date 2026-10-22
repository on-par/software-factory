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

  it('AGENTS.md links CONTEXT.md', () => {
    expect(read('AGENTS.md')).toMatch(/\]\(\.?\/?CONTEXT\.md\)/);
  });

  const TERMS = [
    'Lane',
    'Lane slot',
    'Run',
    'Claim',
    'Lease',
    'Heartbeat',
    'Park',
    'Release',
    'Rework round',
    'CHECK round',
    'Size gate',
    'Slice',
    'Stack',
    'Steward',
    'Trust tier',
    'Constitution',
    'Worktree GC',
    'Quarantine',
    'factoryd',
    'Base hold',
  ];
  const contextSections = (): string[] => read('CONTEXT.md').split(/^### /m).slice(1);
  const sectionFor = (term: string): string | undefined =>
    contextSections().find((section) => section.split('\n')[0]?.trim() === term);

  it('CONTEXT.md defines every domain term with a link to an existing owning module or ADR', () => {
    const missing: string[] = [];
    for (const term of TERMS) {
      const section = sectionFor(term);
      expect(section, `missing term ${term}`).toBeDefined();
      const body = (section ?? '').split('\n').slice(1).join('\n');
      expect(body.replace(/\[[^\]]+\]\([^)]+\)/g, '').trim().length).toBeGreaterThan(0);
      const links = [...body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((m) => m[1] ?? '');
      expect(links.length, `no link for ${term}`).toBeGreaterThan(0);
      for (const link of links) {
        if (/^https?:/.test(link)) continue;
        const target = link.split('#')[0] ?? '';
        if (!existsSync(resolve(REPO_ROOT, target))) missing.push(`${term}: ${link}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('CONTEXT.md lane entry names both meanings and where each is used', () => {
    const lane = sectionFor('Lane') ?? '';
    expect(lane).toContain('bus/index.ts');
    expect(lane).toContain('run-runtime.ts');
  });

  it('docs/architecture.md lists every package and every internal dependency edge', () => {
    const packagesDir = resolve(REPO_ROOT, 'packages');
    const dirs = readdirSync(packagesDir).filter(
      (name) =>
        statSync(resolve(packagesDir, name)).isDirectory() && existsSync(resolve(packagesDir, name, 'package.json')),
    );
    const manifests = dirs.map((dir) => ({
      dir,
      pkg: JSON.parse(read(`packages/${dir}/package.json`)) as Record<string, unknown>,
    }));
    const nameToDir = new Map(manifests.map(({ dir, pkg }) => [String(pkg['name']), dir]));
    const edges: string[] = [];
    for (const { dir, pkg } of manifests) {
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const deps = (pkg[field] ?? {}) as Record<string, string>;
        for (const dep of Object.keys(deps)) {
          const to = nameToDir.get(dep);
          if (to) edges.push(`- \`${dir}\` → \`${to}\``);
        }
      }
    }
    const doc = read('docs/architecture.md');
    const missingDirs = dirs.filter((dir) => !new RegExp('\\|\\s*`' + dir + '`\\s*\\|').test(doc));
    expect(missingDirs).toEqual([]);
    expect(edges.filter((edge) => !doc.includes(edge))).toEqual([]);
  });
});
