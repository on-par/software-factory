import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirs } from '../harness/temp-dir.js';
import { findConfigSchemaErrors, findUnknownConfigKeyWarnings } from './config-schema-lint.js';

describe('findConfigSchemaErrors (#2611)', () => {
  const dirs: string[] = [];
  const temp = createTempDirs();
  afterEach(async () => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    await temp.cleanup();
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

  it.each(['', '  \n\n', '# all commented out\n'])(
    'reports an empty, whitespace-only or comment-only file at the root',
    (text) => {
      const f = run('config.yaml', text);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ file: '.factory/config.yaml', line: 1, path: '(root)' });
      expect(f[0].fix).toContain('delete the file');
    },
  );

  it('reports a JSON null document at the root without a line', () => {
    const f = run('config.json', 'null');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ path: '(root)' });
    expect(f[0].line).toBeUndefined();
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

  it('reports a YAML syntax error with a line through the shared reader', () => {
    const [f] = run('config.yaml', 'a: [unclosed\n');
    expect(f).toMatchObject({ path: '(syntax)', fix: 'fix the YAML syntax' });
    expect(f!.message).toContain('Failed to parse');
    expect(f!.line).toBeDefined();
  });

  it('reports a BOM-prefixed config.json as a syntax error', () => {
    const [f] = run('config.json', '\uFEFF{"version":2}');
    expect(f).toMatchObject({ path: '(syntax)', fix: 'fix the JSON syntax' });
  });

  it('reports config.yaml beside config.json as a file finding naming both', () => {
    const dir = temp.makeSync('schema-lint-');
    writeFileSync(join(dir, 'config.yaml'), 'version: 2\n');
    writeFileSync(join(dir, 'config.json'), '{"version":2}');
    const [f] = findConfigSchemaErrors({ absPath: join(dir, 'config.yaml'), relPath: '.factory/config.yaml' });
    expect(f).toMatchObject({ path: '(file)' });
    expect(f!.message).toContain('config.yaml');
    expect(f!.message).toContain('config.json');
  });
});

describe('findUnknownConfigKeyWarnings (#3568)', () => {
  const temp = createTempDirs();
  afterEach(() => temp.cleanup());

  function warn(name: string, content?: string) {
    const dir = temp.makeSync('unknown-keys-');
    if (content !== undefined) writeFileSync(join(dir, name), content);
    return findUnknownConfigKeyWarnings({ absPath: join(dir, name), relPath: `.factory/${name}` });
  }

  it('reports sandbox.foo with its line and nothing for a config of known keys', () => {
    const [f, ...rest] = warn('config.yaml', 'sandbox:\n  writablePaths: []\n  foo: 1\n');
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ file: '.factory/config.yaml', path: 'sandbox.foo', line: 3 });
    expect(f!.message).toContain("unknown key 'sandbox.foo'");
    expect(f!.fix).toContain("remove 'sandbox.foo'");
    expect(warn('config.yaml', 'sandbox:\n  writablePaths: []\n')).toEqual([]);
  });

  it('reports a JSON config without a line', () => {
    const [f] = warn('config.json', '{"sandbox":{"foo":1}}');
    expect(f).toMatchObject({ path: 'sandbox.foo' });
    expect(f!.line).toBeUndefined();
  });

  it('returns nothing for a missing, empty, non-mapping or unparsable file', () => {
    expect(warn('config.yaml')).toEqual([]);
    expect(warn('config.yaml', '')).toEqual([]);
    expect(warn('config.yaml', '- a\n')).toEqual([]);
    expect(warn('config.yaml', 'a: [unclosed\n')).toEqual([]);
  });
});
