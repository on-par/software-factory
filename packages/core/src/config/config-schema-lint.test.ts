import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findConfigSchemaErrors } from './config-schema-lint.js';

describe('findConfigSchemaErrors (#2611)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function run(name: string, content: string) {
    const dir = mkdtempSync(join(tmpdir(), 'schema-lint-'));
    dirs.push(dir);
    const absPath = join(dir, name);
    writeFileSync(absPath, content);
    return findConfigSchemaErrors({ absPath, relPath: `.factory/${name}` });
  }

  it('returns nothing for a clean file', () => {
    expect(run('config.yaml', 'sweep:\n  loopIntervalSeconds: 300\n')).toEqual([]);
  });

  it('returns nothing for a missing file', () => {
    expect(findConfigSchemaErrors({ absPath: '/nonexistent/config.yaml', relPath: 'config.yaml' })).toEqual([]);
  });

  it('returns nothing for an empty file', () => {
    expect(run('config.yaml', '')).toEqual([]);
  });

  it('reports a wrong type at its line with a fix', () => {
    const f = run('config.yaml', 'sweep:\n  loopIntervalSeconds: soon\n');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ file: '.factory/config.yaml', line: 2, path: 'sweep.loopIntervalSeconds' });
    expect(f[0].fix).toContain('sweep.loopIntervalSeconds');
  });

  it('reports an unknown nested key (v2) at the key line', () => {
    const f = run('config.yaml', 'version: 2\nmodels:\n  pins:\n    bogus: x\n');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ path: 'models.pins.bogus', line: 4, message: "unknown key 'bogus'" });
  });

  it('reports a YAML syntax error with a line', () => {
    const f = run('config.yaml', 'sweep: [\n');
    expect(f).toHaveLength(1);
    expect(f[0].path).toBe('(syntax)');
    expect(f[0].line).toBeDefined();
    expect(f[0].fix).toBe('fix the YAML syntax');
  });

  it('reports a JSON schema error without a line', () => {
    const f = run('config.json', '{"sweep":{"loopIntervalSeconds":"soon"}}');
    expect(f).toHaveLength(1);
    expect(f[0].path).toBe('sweep.loopIntervalSeconds');
    expect(f[0].line).toBeUndefined();
  });

  it('reports a JSON syntax error', () => {
    const f = run('config.json', '{');
    expect(f[0]).toMatchObject({ path: '(syntax)', fix: 'fix the JSON syntax' });
  });

  it('reports a non-mapping file at the root', () => {
    const f = run('config.yaml', '- a\n');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ path: '(root)', line: 1 });
  });
});
