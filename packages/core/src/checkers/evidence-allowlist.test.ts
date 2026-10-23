import { describe, expect, it } from 'vitest';
import { resolveEvidenceAllowlist, tokenizeEvidenceCommand } from './evidence-allowlist.js';

describe('evidence allowlist', () => {
  it('allowlist is the union of package.json scripts and config commands', () => {
    const actual = resolveEvidenceAllowlist(
      { packageManager: 'pnpm@9.1.0', scripts: { test: 'vitest', build: 'tsc' } },
      { commands: { inspect: 'node tools/check.mjs', build: 'npm run build' } },
    );
    expect([...actual]).toEqual([
      ['test', ['pnpm', 'run', 'test']],
      ['inspect', ['node', 'tools/check.mjs']],
      ['build', ['npm', 'run', 'build']],
    ]);
    expect([...resolveEvidenceAllowlist(null, null)]).toEqual([]);
  });

  it('declared checks beat same-named scripts, and explicit commands beat checks', () => {
    const actual = resolveEvidenceAllowlist(
      { scripts: { test: 'vitest', lint: 'oxlint' } },
      {
        checks: { build: 'dotnet build App.sln', test: 'pwsh ./.githooks/run-tests.ps1', lint: 'dotnet format' },
        commands: { lint: 'node tools/lint.mjs' },
      },
    );
    expect(actual.get('build')).toEqual(['dotnet', 'build', 'App.sln']);
    expect(actual.get('test')).toEqual(['pwsh', './.githooks/run-tests.ps1']);
    expect(actual.get('lint')).toEqual(['node', 'tools/lint.mjs']);
  });

  it('selects managers from packageManager before lockfiles and uses deterministic lockfile precedence', () => {
    expect(resolveEvidenceAllowlist({ packageManager: 'bun@1.2.0', scripts: { test: '' } }, null).get('test')).toEqual([
      'bun',
      'run',
      'test',
    ]);
    for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
      expect(
        resolveEvidenceAllowlist({ packageManager: `${manager}@1.0.0`, scripts: { test: 'x' } }, null).get('test')?.[0],
      ).toBe(manager);
    }
    const locks: [string, string][] = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lock', 'bun'],
      ['bun.lockb', 'bun'],
      ['npm-shrinkwrap.json', 'npm'],
      ['package-lock.json', 'npm'],
    ];
    for (const [lock, manager] of locks)
      expect(resolveEvidenceAllowlist({ scripts: { test: 'x' } }, null, [lock]).get('test')?.[0]).toBe(manager);
    expect(
      resolveEvidenceAllowlist({ scripts: { test: 'x' } }, null, ['package-lock.json', 'pnpm-lock.yaml']).get(
        'test',
      )?.[0],
    ).toBe('pnpm');
    expect(
      resolveEvidenceAllowlist({ packageManager: '/tmp/npm', scripts: { test: 'x' } }, null).get('test')?.[0],
    ).toBe('npm');
  });

  it('ignores malformed sources and removes unsafe command overrides', () => {
    expect([
      ...resolveEvidenceAllowlist(
        { scripts: { ok: 'x', bad: 2, 'bad name': 'x' } },
        { commands: JSON.parse('{"ok":"echo | cat","__proto__":"safe"}') as Record<string, string> },
      ),
    ]).toEqual([]);
    expect([...resolveEvidenceAllowlist({ scripts: { test: 'x' } }, { commands: { test: 'npm test | cat' } })]).toEqual(
      [],
    );
    expect([...resolveEvidenceAllowlist({ scripts: null }, null)]).toEqual([]);
    expect([
      ...resolveEvidenceAllowlist(JSON.parse('{"scripts":{"constructor":"x","prototype":"x","__proto__":"x"}}'), null),
    ]).toEqual([]);
  });

  it('tokenizes quoted literals and rejects shell syntax', () => {
    expect(tokenizeEvidenceCommand('vitest run "src/a b.test.ts"')).toEqual(['vitest', 'run', 'src/a b.test.ts']);
    for (const bad of [
      '',
      'x "unfinished',
      'x\\ y',
      'x | cat',
      'x > out',
      'x < in',
      'x; y',
      'x & y',
      'x `id`',
      'x $(id)',
      'x $HOME',
      'x *',
      'x\ny',
      'X=1 x',
    ])
      expect(tokenizeEvidenceCommand(bad)).toBeNull();
  });
});
