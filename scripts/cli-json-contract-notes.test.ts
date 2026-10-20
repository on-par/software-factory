import { describe, expect, it } from 'vitest';

import { renderCliJsonContractNotes, runCliJsonContractNotes } from './cli-json-contract-notes.js';

function schema(properties: Record<string, unknown>, version = 1): unknown {
  return {
    type: 'object',
    properties: { schemaVersion: { type: 'number', const: version }, ...properties },
    required: ['schemaVersion', ...Object.keys(properties)],
  };
}

const str = { type: 'string' };
const breaker = { type: 'object', properties: { open: { type: 'boolean' } }, required: ['open'] };

describe('renderCliJsonContractNotes', () => {
  it('lists an added status field under additive changes with no breaking section', () => {
    const out = renderCliJsonContractNotes(
      { status: schema({ repo: str }) },
      { status: schema({ repo: str, extra: str }) },
    );
    expect(out).toBe('## CLI JSON contract\n\n### Added fields\n\n- `status`: added `extra`\n');
    expect(out).not.toContain('Breaking');
  });

  it('lists a status schemaVersion 1 -> 2 bump first under breaking changes', () => {
    const out = renderCliJsonContractNotes(
      { runs: schema({ a: str }), status: schema({ breaker }) },
      { runs: schema({ a: str, total: str }), status: schema({ breaker: str }, 2) },
    );
    expect(out.indexOf('### Breaking')).toBeLessThan(out.indexOf('### Added fields'));
    expect(out).toContain('- `status`: schemaVersion 1 -> 2\n  - `breaker`: object -> string (field type changed)');
    expect(out.split('\n').find((l) => l.startsWith('- '))).toContain('`status`');
  });

  it('prints No CLI JSON contract changes for identical schema sets', () => {
    const set = { status: schema({ repo: str }) };
    expect(renderCliJsonContractNotes(set, set)).toBe('## CLI JSON contract\n\nNo CLI JSON contract changes\n');
  });

  it('lists new commands, removed commands and unbumped incompatible changes', () => {
    const out = renderCliJsonContractNotes(
      { gone: schema({}, 3), status: schema({ breaker }) },
      { 'queue-add': schema({}), status: schema({ breaker: str }) },
    );
    expect(out).toContain('- `gone`: schema removed (was schemaVersion 3)');
    expect(out).toContain('- `status`: schemaVersion 1 (not bumped)');
    expect(out).toContain('### New commands\n\n- `queue-add` (schemaVersion 1)');
  });

  it('reads the top-level version of logs-line and notes decreases', () => {
    const out = renderCliJsonContractNotes(
      { status: schema({}, 2) },
      { 'logs-line': { type: 'object', schemaVersion: 4 }, status: schema({}, 1) },
    );
    expect(out).toContain('- `logs-line` (schemaVersion 4)');
    expect(out).toContain('schemaVersion 2 -> 1 (decreased)');
  });
});

function fakeGit(trees: Record<string, string[]>, blobs: Record<string, unknown>) {
  return (args: readonly string[]) => {
    if (args[0] === 'ls-tree') {
      const paths = trees[args[4] ?? ''];
      if (!paths) throw new Error(`unknown ref ${args[4]}`);
      return paths.join('\0') + (paths.length ? '\0' : '');
    }
    const key = args[1] ?? '';
    if (!(key in blobs)) throw new Error(`unexpected ${key}`);
    return typeof blobs[key] === 'string' ? blobs[key] : JSON.stringify(blobs[key]);
  };
}

function run(argv: string[], git: (args: readonly string[]) => string) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = runCliJsonContractNotes(argv, {
    cwd: '/repo',
    git,
    log: (l) => lines.push(l),
    error: (l) => errors.push(l),
  });
  return { code, lines, errors };
}

const P = 'packages/cli/schemas/status.schema.json';

describe('runCliJsonContractNotes', () => {
  const git = fakeGit(
    { v1: [P], v2: [P], HEAD: [P], empty: [] },
    { [`v1:${P}`]: schema({ a: str }), [`v2:${P}`]: schema({ a: str, b: str }), [`HEAD:${P}`]: schema({ a: str }) },
  );

  it('defaults --to to HEAD', () => {
    const r = run(['--from', 'v1'], git);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(['## CLI JSON contract\n\nNo CLI JSON contract changes']);
  });

  it('honours an explicit --to in either order', () => {
    const r = run(['--to', 'v2', '--from', 'v1'], git);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toContain('- `status`: added `b`');
  });

  it('treats an empty --from tree as all new commands', () => {
    const r = run(['--from', 'empty'], git);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toContain('- `status` (schemaVersion 1)');
  });

  it('returns 2 on usage errors and an empty --to tree', () => {
    for (const argv of [[], ['--from'], ['--from', '-x'], ['--from', 'v1', 'extra'], ['--to', 'v2']]) {
      const r = run(argv, git);
      expect(r.code).toBe(2);
      expect(r.errors.at(-1)).toBe('usage: cli-json-contract-notes.ts --from <tag> [--to <ref>]');
    }
    expect(run(['--from', 'v1', '--to', 'empty'], git).code).toBe(2);
  });

  it('returns 2 on malformed JSON', () => {
    const bad = fakeGit({ v1: [P], HEAD: [P] }, { [`v1:${P}`]: '{nope', [`HEAD:${P}`]: schema({}) });
    expect(run(['--from', 'v1'], bad).code).toBe(2);
  });
});
