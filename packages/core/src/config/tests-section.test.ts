import { describe, expect, it } from 'vitest';

import { RepoFactoryConfigV2Schema } from './repo.js';

const parse = (tests: unknown) => RepoFactoryConfigV2Schema.safeParse({ version: 2, tests });

describe('tests.affected repo config (#3260)', () => {
  it('accepts a command with {files} and fullOn globs', () => {
    const r = parse({ affected: { command: 'npx vitest related --run {files}', fullOn: ['infra/**'] } });
    expect(r.success).toBe(true);
    expect(r.data?.tests?.affected?.fullOn).toEqual(['infra/**']);
  });

  it.each([
    ['no {files}', 'npx vitest run'],
    ['{files} glued to text', 'npx vitest --files={files}'],
    ['shell syntax', 'npx vitest related {files} | cat'],
  ])('rejects a command with %s', (_name, command) => {
    expect(parse({ affected: { command } }).success).toBe(false);
  });

  it('accepts a shell-free typecheck and a buildVerify value (#4251)', () => {
    const cmd = 'npx vitest related --run {files}';
    const r = parse({ affected: { command: cmd, typecheck: 'npx tsc -b --incremental', buildVerify: 'full' } });
    expect(r.success).toBe(true);
    expect(r.data?.tests?.affected).toMatchObject({ typecheck: 'npx tsc -b --incremental', buildVerify: 'full' });
    expect(parse({ affected: { command: cmd, buildVerify: 'focused' } }).success).toBe(true);
    for (const fullGate of ['check', 'ci']) expect(parse({ affected: { command: cmd, fullGate } }).success).toBe(true);
  });

  it.each([
    ['a shell-metachar typecheck', { typecheck: 'tsc -b && echo hi' }],
    ['an empty typecheck', { typecheck: '' }],
    ['an unknown buildVerify', { buildVerify: 'sometimes' }],
    ['an unknown fullGate', { fullGate: 'nope' }],
  ])('rejects %s', (_name, extra) => {
    expect(parse({ affected: { command: 'npx vitest related --run {files}', ...extra } }).success).toBe(false);
  });

  it('rejects an unknown tests key', () => {
    expect(parse({ foo: {} }).success).toBe(false);
  });

  it('leaves tests undefined when absent', () => {
    const r = RepoFactoryConfigV2Schema.safeParse({ version: 2 });
    expect(r.success).toBe(true);
    expect(r.data?.tests).toBeUndefined();
  });
});
