import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

const RUNBOOKS = readdirSync(resolve(REPO_ROOT, 'docs/runbooks'))
  .filter((name) => name.endsWith('.md'))
  .map((name) => `docs/runbooks/${name}`);

const missingLinks = (rel: string): string[] => {
  const text = read(rel).replace(/^```[\s\S]*?^```/gm, '');
  const missing: string[] = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1] ?? '';
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const file = target.split('#')[0] ?? '';
    if (!existsSync(resolve(REPO_ROOT, dirname(rel), file))) missing.push(`${rel}: ${target}`);
  }
  return missing;
};

describe('docs-quickstart', () => {
  it('README Quick start is a short provider-agnostic happy path', () => {
    const readme = read('README.md');
    const start = readme.indexOf('## Quick start');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = readme.slice(start);
    const end = rest.indexOf('\n## ', 1);
    const section = (end === -1 ? rest : rest.slice(0, end)).replace(/\s+$/, '');
    expect(section.split('\n').length).toBeLessThanOrEqual(40);
    expect(section).not.toMatch(/^### Use /m);
    expect(section).toContain('docs/agents.md');
    expect(readme).toMatch(/^## Safety$/m);

    for (const rel of [
      'README.md',
      'docs/runbooks/factoryd.md',
      'docs/runbooks/factoryd-launchd.md',
      'docs/runbooks/macos-keychain-launchagent.md',
    ]) {
      expect(read(rel), rel).not.toMatch(/\bthe Mini\b/);
    }

    const keychain = read('docs/runbooks/macos-keychain-launchagent.md');
    expect(/^# .*$/m.exec(keychain)?.[0]).toMatch(/^# Optional:/);

    const adr = readdirSync(resolve(REPO_ROOT, 'docs/adr')).find((name) => name.startsWith('0084-'));
    expect(adr).toBeDefined();
    const adrText = read(`docs/adr/${adr}`);
    expect(adrText).toContain('macos-keychain-launchagent.md');
    expect(adrText).toContain('Claude subscription');

    expect(['README.md', ...RUNBOOKS].flatMap(missingLinks)).toEqual([]);
  });

  it('docs/agents.md carries every provider sign-in option and doctor check line', () => {
    const agents = read('docs/agents.md');
    for (const needle of [
      '/login',
      'ANTHROPIC_API_KEY',
      'codex login',
      '--with-api-key',
      '--device-auth',
      'Plus or Pro',
      'firejail',
      'claude installed',
      'claude signed in',
      'codex signed in',
      '--probe-inference',
    ]) {
      expect(agents, needle).toContain(needle);
    }
  });
});
