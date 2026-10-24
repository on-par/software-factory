import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { compareCliJsonSchemas, diffCliJsonSchemas, runCliJsonContractCheck } from './check-cli-json-contract.js';

function schema(
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties),
  version = 1,
): unknown {
  return {
    type: 'object',
    properties: { schemaVersion: { type: 'number', const: version }, ...properties },
    required: ['schemaVersion', ...required],
  };
}

const breaker = { type: 'object', properties: { open: { type: 'boolean' } }, required: ['open'] };
const stringField = { type: 'string' };
const integerVersion = (version: number) => ({
  type: 'object',
  properties: { schemaVersion: { type: 'number', const: version } },
  required: ['schemaVersion'],
});

function runWithGit(responses: Map<string, string>) {
  const lines: string[] = [];
  const errors: string[] = [];
  const git = vi.fn((args: readonly string[]) => {
    const key = args.join(' ');
    const value = responses.get(key);
    if (value === undefined) throw new Error(`unexpected git call: ${key}`);
    return value;
  });
  const code = runCliJsonContractCheck(['--base', 'base-sha'], {
    cwd: '/repo',
    git,
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
  });
  return { code, lines, errors, git };
}

function tree(paths: string[]): string {
  return paths.join('\0') + (paths.length ? '\0' : '');
}

function baseGit(base: string[], head: string[], blobs: Record<string, unknown>) {
  const responses = new Map<string, string>([
    ['ls-tree -r --name-only -z base-sha -- packages/cli/schemas', tree(base)],
    ['ls-tree -r --name-only -z HEAD -- packages/cli/schemas', tree(head)],
  ]);
  for (const [key, value] of Object.entries(blobs)) responses.set(`show ${key}`, JSON.stringify(value));
  return responses;
}

describe('compareCliJsonSchemas', () => {
  it('rejects status breaker object-to-string without a version bump', () => {
    const findings = compareCliJsonSchemas('status', schema({ breaker }), schema({ breaker: stringField }));
    expect(findings).toEqual([
      expect.objectContaining({
        command: 'status',
        path: 'breaker',
        oldType: 'object',
        newType: 'string',
        reason: 'field type changed',
      }),
    ]);
  });

  it('accepts status breaker object-to-string with version 2', () => {
    expect(
      compareCliJsonSchemas('status', schema({ breaker }), schema({ breaker: stringField }, ['breaker'], 2)),
    ).toEqual([]);
  });

  it('accepts additive fields at the same version', () => {
    expect(
      compareCliJsonSchemas('status', schema({ name: stringField }), schema({ name: stringField, extra: stringField })),
    ).toEqual([]);
  });

  it('enforces the breaking-change version matrix', () => {
    const cases = [
      [{ old: stringField }, {}, 'old'],
      [{ before: stringField }, { after: stringField }, 'before'],
      [{ value: stringField }, { value: { type: 'number' } }, 'value'],
    ] as const;
    for (const [before, after, path] of cases) {
      expect(
        compareCliJsonSchemas('sample', schema(before), schema(after)).some((finding) => finding.path === path),
      ).toBe(true);
      expect(compareCliJsonSchemas('sample', schema(before), schema(after, Object.keys(after), 2))).toEqual([]);
    }
    expect(
      compareCliJsonSchemas(
        'sample',
        schema({ value: stringField }),
        schema({ value: stringField, added: stringField }),
      ),
    ).toEqual([]);
  });

  it('catches requiredness, nested fields, array items, nullability, and multiple changes', () => {
    const before = schema(
      {
        nested: { type: 'object', properties: { a: stringField, gone: stringField }, required: ['a'] },
        rows: { type: 'array', items: { type: 'object', properties: { count: { type: 'number' } } } },
        maybe: { type: ['string', 'null'] },
        stable: stringField,
      },
      ['nested', 'rows', 'maybe', 'stable'],
    );
    const after = schema(
      {
        nested: { type: 'object', properties: { a: stringField }, required: [] },
        rows: { type: 'array', items: { type: 'object', properties: { count: stringField } } },
        maybe: { type: 'string' },
        stable: stringField,
      },
      ['nested', 'rows', 'maybe', 'stable'],
    );
    const findings = compareCliJsonSchemas('sample', before, after);
    expect(findings.map(({ path, reason }) => [path, reason])).toEqual(
      expect.arrayContaining([
        ['nested.a', 'required -> optional'],
        ['nested.gone', 'property removed'],
        ['rows[].count', 'field type changed'],
        ['maybe', 'field type changed'],
      ]),
    );
  });

  it('allows additive required properties and equivalent ordering', () => {
    const left = {
      type: 'object',
      properties: {
        item: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        schemaVersion: { type: 'number', const: 1 },
      },
      required: ['schemaVersion', 'item'],
    };
    const right = {
      required: ['extra', 'item', 'schemaVersion'],
      properties: {
        schemaVersion: { const: 1, type: 'number' },
        extra: stringField,
        item: { anyOf: [{ type: 'null' }, { type: 'string' }] },
      },
      type: 'object',
    };
    expect(compareCliJsonSchemas('sample', left, right)).toEqual([]);
  });

  it('keeps per-command versions independent', () => {
    expect(
      compareCliJsonSchemas('one', schema({ x: stringField }), schema({ x: { type: 'number' } }, ['x'], 2)),
    ).toEqual([]);
    expect(compareCliJsonSchemas('two', schema({ x: stringField }), schema({ x: { type: 'number' } }))).toHaveLength(1);
  });

  it('validates normal versions and rejects decreases and malformed explicit values', () => {
    expect(
      compareCliJsonSchemas('sample', schema({ x: stringField }, ['x'], 2), schema({ x: stringField }, ['x'], 1))[0]
        ?.reason,
    ).toContain('must not decrease');
    for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        compareCliJsonSchemas(
          'sample',
          { ...integerVersion(version), properties: { schemaVersion: { const: version } } },
          schema({}),
        ),
      ).toThrow();
    }
    expect(() => compareCliJsonSchemas('sample', { type: 'object', properties: {} }, schema({}))).toThrow(
      'properties.schemaVersion.const',
    );
  });

  it('supports legacy logs version 1 and schema-only metadata version 2', () => {
    const before = { type: 'object', properties: { event: stringField }, required: ['event'] };
    const breaking = { type: 'object', properties: {}, required: [] };
    expect(compareCliJsonSchemas('logs-line', before, before)).toEqual([]);
    expect(compareCliJsonSchemas('logs-line', before, breaking)).toHaveLength(1);
    expect(compareCliJsonSchemas('logs-line', before, { ...breaking, schemaVersion: 2 })).toEqual([]);
  });

  it('reports changed unsupported structures independent of key ordering', () => {
    expect(
      compareCliJsonSchemas(
        'sample',
        schema({ x: { type: 'string', enum: ['a', 'b'] } }),
        schema({ x: { enum: ['a', 'b'], type: 'string' } }),
      ),
    ).toEqual([]);
    expect(
      compareCliJsonSchemas('sample', schema({ x: { $ref: '#/$defs/A' } }), schema({ x: { $ref: '#/$defs/B' } })),
    ).toHaveLength(1);
  });
});

describe('compareCliJsonSchemas anyOf const branches', () => {
  it('treats an unchanged schema with same-type const branches as compatible', () => {
    const schema = {
      type: 'object',
      properties: {
        schemaVersion: { type: 'number', const: 1 },
        exitCode: {
          anyOf: [
            { type: 'number', const: 0 },
            { type: 'number', const: 1 },
          ],
        },
      },
      required: ['schemaVersion', 'exitCode'],
    };
    expect(compareCliJsonSchemas('check', schema, structuredClone(schema))).toEqual([]);
  });
});

describe('runCliJsonContractCheck', () => {
  it.each([[], ['--base'], ['--base', ' '], ['--base', '-main'], ['--unknown', 'main'], ['--base', 'main', 'extra']])(
    'rejects invalid args %j without invoking Git',
    (argv) => {
      const git = vi.fn(() => '');
      expect(runCliJsonContractCheck(argv, { git, error: () => undefined })).toBe(2);
      expect(git).not.toHaveBeenCalled();
    },
  );

  it('reads base and HEAD snapshots with NUL listing and schema restriction', () => {
    const path = 'packages/cli/schemas/status.schema.json';
    const responses = baseGit([path], [path], {
      [`base-sha:${path}`]: schema({ x: stringField }),
      [`HEAD:${path}`]: schema({ x: stringField }),
    });
    const { code, lines, git } = runWithGit(responses);
    expect(code).toBe(0);
    expect(lines).toEqual(['check-cli-json-contract: OK']);
    expect(git.mock.calls[0]?.[0]).toEqual([
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      'base-sha',
      '--',
      'packages/cli/schemas',
    ]);
    expect(git.mock.calls).toContainEqual([['show', `base-sha:${path}`]]);
    expect(git.mock.calls).toContainEqual([['show', `HEAD:${path}`]]);
  });

  it('allows new schemas, deleted schemas fail, and an empty base allows first introduction', () => {
    const path = 'packages/cli/schemas/status.schema.json';
    const newOnly = runWithGit(baseGit([], [path], { [`HEAD:${path}`]: schema({}) }));
    expect(newOnly.code).toBe(0);
    const other = 'packages/cli/schemas/other.schema.json';
    const deleted = runWithGit(
      baseGit([path, other], [other], {
        [`base-sha:${path}`]: schema({}),
        [`base-sha:${other}`]: schema({}),
        [`HEAD:${other}`]: schema({}),
      }),
    );
    expect(deleted.code).toBe(1);
    expect(deleted.errors.join('\n')).toContain('status $: schema -> <removed>');
  });

  it('fails closed for missing refs, malformed blobs, and empty HEAD inventory', () => {
    const missing = runWithGit(new Map());
    expect(missing.code).toBe(2);
    const path = 'packages/cli/schemas/status.schema.json';
    const malformed = runWithGit(
      new Map([
        ['ls-tree -r --name-only -z base-sha -- packages/cli/schemas', tree([path])],
        ['ls-tree -r --name-only -z HEAD -- packages/cli/schemas', tree([path])],
        [`show base-sha:${path}`, '{'],
      ]),
    );
    expect(malformed.code).toBe(2);
    expect(malformed.errors.join('\n')).toContain('malformed JSON');
    const emptyHead = runWithGit(
      new Map([
        ['ls-tree -r --name-only -z base-sha -- packages/cli/schemas', ''],
        ['ls-tree -r --name-only -z HEAD -- packages/cli/schemas', ''],
      ]),
    );
    expect(emptyHead.code).toBe(2);
    expect(emptyHead.errors.join('\n')).toContain('HEAD has no CLI schema artifacts');
  });

  it('does not execute the runner when imported and wires the PR guard in CI', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const staticJob = workflow.slice(workflow.indexOf('  static:'), workflow.indexOf('  test:'));
    expect(staticJob).toContain('fetch-depth: 0');
    expect(staticJob).toContain("if: github.event_name == 'pull_request'");
    expect(staticJob).toContain('CLI_JSON_BASE_SHA: ${{ github.event.pull_request.base.sha }}');
    expect(staticJob).toContain('npx tsx scripts/check-cli-json-contract.ts --base "$CLI_JSON_BASE_SHA"');
    expect(runCliJsonContractCheck).toBeTypeOf('function');
  });
});

describe('diffCliJsonSchemas', () => {
  it('reports added top-level and nested fields', () => {
    const lanes = (extra: Record<string, unknown>) => ({
      type: 'array',
      items: { type: 'object', properties: { id: stringField, ...extra }, required: ['id'] },
    });
    const diff = diffCliJsonSchemas(
      'runs',
      schema({ lanes: lanes({}) }),
      schema({ lanes: lanes({ pr: stringField }), total: stringField }),
    );
    expect(diff.added).toEqual(['lanes[].pr', 'total']);
    expect(diff.breaking).toEqual([]);
    expect([diff.oldVersion, diff.newVersion]).toEqual([1, 1]);
  });

  it('still reports a retype and both versions when schemaVersion was bumped', () => {
    const diff = diffCliJsonSchemas('status', schema({ breaker }), schema({ breaker: stringField }, ['breaker'], 2));
    expect([diff.oldVersion, diff.newVersion]).toEqual([1, 2]);
    expect(diff.breaking).toEqual([expect.objectContaining({ path: 'breaker', reason: 'field type changed' })]);
  });
});
