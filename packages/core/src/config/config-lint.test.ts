import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConstitutionLoader } from '../constitutions/index.js';
import { lintFactoryConfig } from './config-lint.js';

describe('lintFactoryConfig (#2612)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const fm = (checkers: string, extra = '') =>
    `---\nproduct: acme${extra}\nversion: 1\ncheckers:\n  - ${checkers}\n---\nbody\n`;

  function lint(constitution: string | null, config = 'sweep:\n  enabled: false\n') {
    const dir = mkdtempSync(join(tmpdir(), 'config-lint-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.factory'));
    if (constitution !== null) writeFileSync(join(dir, '.factory', 'constitution.md'), constitution);
    const y = join(dir, '.factory', 'config.yaml');
    writeFileSync(y, config);
    return lintFactoryConfig({
      constitution: new ConstitutionLoader().loadRepoConstitution(dir),
      configFile: { absPath: y, relPath: '.factory/config.yaml' },
    });
  }

  it('is ok for a clean constitution and config', () => {
    expect(lint(fm('compile'))).toEqual({ verdict: 'ok', findings: [] });
  });

  it('escalates an unknown checker with file:line', () => {
    const r = lint(fm('typecheck'));
    expect(r.verdict).toBe('escalate');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      rule: 'unknown-checker',
      file: '.factory/constitution.md',
      line: 5,
      token: 'typecheck',
    });
    expect(r.findings[0].message).toContain(".factory/constitution.md:5: unknown checker 'typecheck'");
  });

  it('reports a <checker-name> placeholder once', () => {
    const r = lint(fm('<checker-name>'));
    expect(r.verdict).toBe('escalate');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].rule).toBe('unknown-checker');
  });

  it('parks on a frontmatter token', () => {
    const r = lint(fm('compile', '\ndescription: <what it does>'));
    expect(r.verdict).toBe('park');
    expect(r.findings[0]).toMatchObject({ rule: 'template-token', token: '<what it does>' });
  });

  it('parks on a config.yaml token', () => {
    const r = lint(fm('compile'), 'models:\n  pins:\n    build: <model id>\n');
    expect(r.verdict).toBe('park');
    expect(r.findings[0]).toMatchObject({ rule: 'template-token', file: '.factory/config.yaml', line: 3 });
  });

  it('escalates and keeps both findings when a checker and a token are bad', () => {
    const r = lint(fm('typecheck'), 'models:\n  pins:\n    build: <model id>\n');
    expect(r.verdict).toBe('escalate');
    expect(r.findings.map((f) => f.rule)).toEqual(['unknown-checker', 'template-token']);
  });

  it('is ok with no constitution and no config file', () => {
    expect(lintFactoryConfig({ constitution: null })).toEqual({ verdict: 'ok', findings: [] });
  });
});
