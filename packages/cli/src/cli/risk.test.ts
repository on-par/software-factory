import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_RISK_RULES } from '@on-par/factory-config';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliExitError, main } from './index.js';
import {
  cmdRisk,
  parsePrArg,
  RiskCommandError,
  runRiskCommand,
  type RiskCommandDeps,
  type RiskRuntime,
} from './risk.js';

function makeDeps(overrides: Partial<RiskCommandDeps> = {}): RiskCommandDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    repo: 'o/r',
    listFiles: async () => ['src/auth/login.ts', 'README.md'],
    readFile: () => '{}',
    fileExists: () => true,
    loadRepoPolicy: () => ({ source: 'default', file: '.factory/config.yaml', rules: DEFAULT_RISK_RULES }),
    log: (line) => lines.push(line),
    ...overrides,
    lines,
  };
}

async function failure(p: Promise<unknown>): Promise<RiskCommandError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(RiskCommandError);
    return err as RiskCommandError;
  }
  throw new Error('expected rejection');
}

describe('factory risk', () => {
  it('prints tier high for a PR touching an auth path', async () => {
    const deps = makeDeps();
    const evaluation = await runRiskCommand('42', {}, deps);
    expect(evaluation.tier).toBe('high');
    expect(deps.lines[0]).toBe('PR #42: tier high');
  });

  it('lists every matched rule with its tier and paths', async () => {
    const deps = makeDeps();
    const evaluation = await runRiskCommand('42', {}, deps);
    expect(deps.lines).toContain('  - auth (high): src/auth/login.ts');
    expect(deps.lines).toContain('  - docs (low): README.md');
    expect(deps.lines).toContain('Policy: packaged defaults');
    expect(deps.lines.filter((l) => l.startsWith('  - '))).toHaveLength(evaluation.rules.length);
  });

  it('rejects an invalid or unknown PR with a non-zero exit and a clear message', async () => {
    for (const raw of ['abc', '0', '-3', '99999999999999999999']) {
      const listFiles = vi.fn(async () => []);
      const err = await failure(runRiskCommand(raw, {}, makeDeps({ listFiles })));
      expect(err.code).toBe(2);
      expect(err.message).toContain('invalid PR argument');
      expect(listFiles).not.toHaveBeenCalled();
    }
    const notFound = makeDeps({
      listFiles: async () => {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      },
    });
    const err = await failure(runRiskCommand('7', {}, notFound));
    expect(err.code).toBe(1);
    expect(err.message).toBe('factory risk: PR #7 not found in o/r');
  });

  it('reports other GitHub errors', async () => {
    const deps = makeDeps({
      listFiles: async () => {
        throw new Error('boom');
      },
    });
    const err = await failure(runRiskCommand('7', {}, deps));
    expect(err.code).toBe(1);
    expect(err.message).toBe('factory risk: could not list files for PR #7 — boom');
  });

  it('accepts #N', () => {
    expect(parsePrArg('#42')).toBe(42);
  });

  it('reports a missing policy file', async () => {
    const err = await failure(runRiskCommand('1', { policy: 'nope.json' }, makeDeps({ fileExists: () => false })));
    expect(err.code).toBe(2);
    expect(err.message).toBe('factory risk: risk policy file not found: nope.json');
  });

  it('reports an invalid policy file', async () => {
    const contents = ['not json', '{ "rules": [{ "id": "X", "tier": "high", "globs": ["a"] }] }'];
    for (const content of contents) {
      const err = await failure(runRiskCommand('1', { policy: 'p.json' }, makeDeps({ readFile: () => content })));
      expect(err.code).toBe(2);
      expect(err.message).toMatch(/^factory risk: invalid risk policy p\.json/);
    }
  });

  it('uses a custom policy', async () => {
    const policy = JSON.stringify({ rules: [{ id: 'all', tier: 'low', globs: ['**'] }] });
    const deps = makeDeps({ readFile: () => policy });
    const evaluation = await runRiskCommand('1', { policy: 'p.json' }, deps);
    expect(evaluation.tier).toBe('low');
    expect(deps.lines).toContain('Policy: p.json');
  });

  it('prints the empty-diff rule', async () => {
    const deps = makeDeps({ listFiles: async () => [] });
    await runRiskCommand('1', {}, deps);
    expect(deps.lines).toContain('  - empty-diff (med): (no changed files)');
  });
});

describe('cmdRisk runtime wiring', () => {
  const tmp = createTempDirs();
  afterEach(async () => {
    await tmp.cleanup();
    vi.restoreAllMocks();
  });

  function runtime(repoRoot: string, octokit: unknown = {}) {
    const lines: string[] = [];
    const rt: RiskRuntime = {
      getRepoRoot: vi.fn(async () => repoRoot),
      getGitHubRepo: vi.fn(async () => 'o/r'),
      getOctokit: () => octokit as ReturnType<RiskRuntime['getOctokit']>,
      CliExitError,
      log: (line) => lines.push(line),
    };
    return { rt, lines };
  }

  const octokitWithFiles = (files: string[]) => ({
    rest: { pulls: { listFiles: async () => ({ data: files.map((filename) => ({ filename })) }) } },
  });

  it('uses the `risk` section of .factory/config.yaml by default', async () => {
    const root = await tmp.make('risk-repo-');
    mkdirSync(join(root, '.factory'));
    writeFileSync(
      join(root, '.factory', 'config.yaml'),
      'version: 2\nrisk:\n  rules:\n    - id: everything\n      tier: low\n      globs: ["**"]\n',
    );
    const { rt, lines } = runtime(root, octokitWithFiles(['src/auth/login.ts']));
    await cmdRisk('#5', {}, rt);
    expect(lines).toEqual([
      'PR #5: tier low',
      'Policy: .factory/config.yaml `risk`',
      'Matched rules:',
      '  - everything (low): src/auth/login.ts',
    ]);
  });

  it('falls back to the packaged defaults and reads --policy relative to the repo root', async () => {
    const root = await tmp.make('risk-repo-');
    const { rt, lines } = runtime(root, octokitWithFiles(['src/auth/login.ts']));
    await cmdRisk('5', {}, rt);
    expect(lines.slice(0, 2)).toEqual(['PR #5: tier high', 'Policy: packaged defaults']);

    writeFileSync(join(root, 'p.json'), JSON.stringify({ rules: [{ id: 'all', tier: 'med', globs: ['**'] }] }));
    lines.length = 0;
    await cmdRisk('5', { policy: 'p.json' }, rt);
    expect(lines.slice(0, 2)).toEqual(['PR #5: tier med', 'Policy: p.json']);
  });

  it('maps an invalid repo policy to exit 2', async () => {
    const root = await tmp.make('risk-repo-');
    mkdirSync(join(root, '.factory'));
    writeFileSync(join(root, '.factory', 'config.yaml'), 'version: 2\nrisk:\n  rules: nope\n');
    const { rt } = runtime(root);
    await expect(cmdRisk('5', {}, rt)).rejects.toMatchObject({
      name: 'CliExitError',
      code: 2,
      message: expect.stringMatching(
        /^factory risk: invalid risk policy — invalid `risk` section in \.factory\/config\.yaml: /,
      ),
    });
  });

  it('exits 2 on a bad <pr> before any repo lookup, and rethrows unexpected errors', async () => {
    const { rt } = runtime('/nonexistent');
    await expect(cmdRisk('abc', {}, rt)).rejects.toMatchObject({ name: 'CliExitError', code: 2 });
    expect(rt.getRepoRoot).not.toHaveBeenCalled();

    const boom = new Error('no repo');
    rt.getRepoRoot = async () => {
      throw boom;
    };
    await expect(cmdRisk('5', {}, rt)).rejects.toBe(boom);
  });

  it('is wired into the CLI entry point', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    try {
      await main(['node', 'factory', 'risk', 'abc']);
      expect(process.exitCode).toBe(2);
      expect(errSpy.mock.calls.flat().join('\n')).toContain("factory risk: invalid PR argument 'abc'");
    } finally {
      process.exitCode = undefined;
    }
  });
});
