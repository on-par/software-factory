import { describe, expect, it } from 'vitest';
import { findConfigSchemaErrors } from './schema-findings.js';

const f = (text: string) => findConfigSchemaErrors(text, 'c.yaml');

describe('findConfigSchemaErrors (#2611)', () => {
  it('returns [] for a valid v2 file', () => {
    expect(f('version: 2\nsweep:\n  enabled: false\n')).toEqual([]);
  });

  it('returns [] for empty and comment-only files', () => {
    expect(f('')).toEqual([]);
    expect(f('# nothing\n')).toEqual([]);
  });

  it('locates a nested unknown key on its own line', () => {
    const [x] = f('version: 2\nmodels:\n  pinz:\n    build: x\n');
    expect(x).toMatchObject({ kind: 'unknown-key', key: 'pinz', line: 3, path: 'models' });
  });

  it('locates a top-level unknown key', () => {
    const found = f('version: 2\nbogus: 1\n').find((x) => x.key === 'bogus');
    expect(found).toMatchObject({ kind: 'unknown-key', line: 2, path: '(root)' });
  });

  it('locates an invalid value', () => {
    const found = f('usage:\n  capUsd: -1\n').find((x) => x.path === 'usage.capUsd');
    expect(found?.line).toBe(2);
    expect(found?.kind).toBe('invalid');
  });

  it('falls back to the nearest existing ancestor line for a missing path', () => {
    const lines = f('sweep:\n  loopIntervalSeconds: maybe\n').map((x) => x.line);
    expect(lines).toContain(2);
    expect(f('version: 2\nmodels:\n  pinz: {}\n').every((x) => x.line >= 1)).toBe(true);
  });

  it('reports a parse error with its line', () => {
    const [x] = f('sweep:\n  enabled: [\n');
    expect(x.kind).toBe('parse');
    expect(x.line).toBeGreaterThanOrEqual(1);
  });

  it('reports a top-level list as a root finding at line 1', () => {
    const out = f('- a\n- b\n');
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((x) => x.line === 1)).toBe(true);
  });

  it('parses JSON text', () => {
    expect(f('{"version": 2, "sweep": {"enabled": false}}')).toEqual([]);
    expect(f('{\n"sweep": {"loopIntervalSeconds": "maybe"}\n}')[0]?.path).toBe('sweep.loopIntervalSeconds');
  });
});
