// src/checkers/design-smells.test.ts — CHECK-phase program-design smell critic (#483).

import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import {
  BASE_REF_CANDIDATES,
  buildDesignSmellPrompt,
  captureDiffBase,
  collectDesignDiff,
  DESIGN_SMELLS_CHECKER,
  type DesignSmell,
  designSmellsChecker,
  designSmellsEnabled,
  type DiffRunner,
  MAX_DIFF_CHARS,
  MAX_SMELLS_RENDERED,
  parseDesignSmellVerdict,
  type RejectedSmell,
  renderRejectedSmells,
  renderSmellDetails,
  SMELL_KINDS,
  WORKER_OUTPUT_CHECKER,
  workerOutputChecker,
} from './design-smells.js';
import type { CheckerContext } from './index.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    check_design: { tier: 'boss', description: 'stub' },
  },
};

function makeRouter(output: string): { router: ModelRouter; stub: StubModelExecutor } {
  const stub = new StubModelExecutor({ scripts: { check_design: [{ output }] } });
  return { router: new ModelRouter(models, routes, false, stub), stub };
}

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

const execFile = promisify(execFileCb);

async function makeWorktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'design-smells-test-'));
  tempDirs.add(dir);
  return dir;
}

/** Remote-less git repo (no origin/main or origin/master) with one initial commit. */
async function makeRemoteLessGitRepo(): Promise<{ worktree: string; baseSha: string }> {
  const worktree = await makeWorktree();
  await execFile('git', ['init', '--initial-branch=main'], { cwd: worktree });
  await execFile('git', ['config', 'user.email', 'tests@example.com'], { cwd: worktree });
  await execFile('git', ['config', 'user.name', 'Tests'], { cwd: worktree });
  await writeFile(join(worktree, 'README.md'), '# fixture\n');
  await execFile('git', ['add', '.'], { cwd: worktree });
  await execFile('git', ['commit', '-m', 'initial'], { cwd: worktree });
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: worktree });
  return { worktree, baseSha: stdout.trim() };
}

function makeContext(worktree: string, overrides: Partial<CheckerContext> = {}): CheckerContext {
  return {
    worktree,
    specPath: join(worktree, 'no-such-spec.md'),
    constitutionBody: 'test constitution',
    ...overrides,
  };
}

function smell(overrides: Partial<DesignSmell> = {}): DesignSmell {
  return {
    kind: 'cast-to-pass',
    file: 'packages/core/src/a.ts',
    line: 42,
    evidence: 'casts result as any to satisfy the return type',
    suggestion: 'change the return type to include undefined',
    ...overrides,
  };
}

describe('collectDesignDiff', () => {
  it('resolves origin/main and issues the three-dot diff with DIFF_EXCLUDES pathspecs', async () => {
    const calls: { argv: readonly string[]; cwd: string }[] = [];
    const run: DiffRunner = async (argv, cwd) => {
      calls.push({ argv, cwd });
      if (argv[0] === 'git' && argv[1] === 'rev-parse' && argv[4] === 'origin/main^{commit}') {
        return { ok: true, stdout: '' };
      }
      if (argv.includes('origin/main...HEAD')) {
        return { ok: true, stdout: 'diff --git a/x.ts b/x.ts\n+added line\n' };
      }
      return { ok: true, stdout: '' };
    };

    const result = await collectDesignDiff('/worktree', run);

    expect(result.baseRef).toBe('origin/main');
    expect(result.text).toContain('added line');
    const committedCall = calls.find((c) => c.argv.includes('origin/main...HEAD'));
    expect(committedCall).toBeDefined();
    expect(committedCall!.argv).toEqual(
      expect.arrayContaining([
        'git',
        'diff',
        '--unified=3',
        'origin/main...HEAD',
        '--',
        '.',
        ':!package-lock.json',
        ':!**/package-lock.json',
        ':!*.lock',
        ':!dist/**',
        ':!**/dist/**',
        ':!coverage/**',
        ':!**/*.snap',
        ':!**/__pycache__/**',
        ':!**/*.pyc',
      ]),
    );
    expect(committedCall!.cwd).toBe('/worktree');
  });

  it('uses the provided fallbackBaseRef when neither remote base resolves', async () => {
    const calls: { argv: readonly string[]; cwd: string }[] = [];
    const run: DiffRunner = async (argv, cwd) => {
      calls.push({ argv, cwd });
      if (argv[1] === 'rev-parse') {
        return { ok: argv[4] === 'presha123^{commit}', stdout: '' };
      }
      if (argv.includes('presha123...HEAD')) {
        return { ok: true, stdout: 'diff --git a/x.ts b/x.ts\n+added line\n' };
      }
      return { ok: true, stdout: '' };
    };

    const result = await collectDesignDiff('/worktree', run, { fallbackBaseRef: 'presha123' });

    expect(result.skipReason).toBeUndefined();
    expect(result.baseRef).toBe('presha123');
    expect(result.text).toContain('added line');
    expect(calls.some((c) => c.argv.includes('presha123...HEAD'))).toBe(true);
  });

  it('returns skipReason when the fallbackBaseRef also fails to verify', async () => {
    const run: DiffRunner = async () => ({ ok: false, stdout: '' });

    const result = await collectDesignDiff('/worktree', run, { fallbackBaseRef: 'deadbeef' });

    expect(result.baseRef).toBeNull();
    expect(result.text).toBe('');
    expect(result.skipReason).toContain('no fallback base');
  });

  it('reports excludedPaths when the filtered diff is empty but raw changes exist', async () => {
    const run: DiffRunner = async (argv) => {
      if (argv[1] === 'rev-parse') return { ok: true, stdout: '' };
      if (argv.includes('--name-only') && argv.includes('origin/main...HEAD')) {
        return { ok: true, stdout: 'pkg/__pycache__/mod.cpython-311.pyc\na/first.pyc\n' };
      }
      if (argv.includes('--name-only') && argv.includes('HEAD')) {
        return { ok: true, stdout: 'a/first.pyc\nz/last.pyc\n' };
      }
      return { ok: true, stdout: '' };
    };

    const result = await collectDesignDiff('/worktree', run);

    expect(result.text).toBe('');
    expect(result.skipReason).toBeUndefined();
    expect(result.excludedPaths).toEqual(['a/first.pyc', 'pkg/__pycache__/mod.cpython-311.pyc', 'z/last.pyc']);
  });

  it('leaves excludedPaths unset when the raw name-only diffs are also empty', async () => {
    const run: DiffRunner = async (argv) => {
      if (argv[1] === 'rev-parse') return { ok: true, stdout: '' };
      return { ok: true, stdout: '' };
    };

    const result = await collectDesignDiff('/worktree', run);

    expect(result.text).toBe('');
    expect(result.excludedPaths).toBeUndefined();
  });

  it('does not run the name-only diffs when the filtered diff is non-empty', async () => {
    const calls: readonly string[][] = [];
    const run: DiffRunner = async (argv) => {
      (calls as string[][]).push([...argv]);
      if (argv[1] === 'rev-parse') return { ok: true, stdout: '' };
      if (argv.includes('origin/main...HEAD')) return { ok: true, stdout: 'real diff\n' };
      return { ok: true, stdout: '' };
    };

    const result = await collectDesignDiff('/worktree', run);

    expect(result.text).toContain('real diff');
    expect(result.excludedPaths).toBeUndefined();
    expect(calls.some((argv) => argv.includes('--name-only'))).toBe(false);
  });

  it('falls back to origin/master when the first rev-parse fails', async () => {
    const run: DiffRunner = async (argv) => {
      if (argv[4] === 'origin/main^{commit}') return { ok: false, stdout: '' };
      if (argv[4] === 'origin/master^{commit}') return { ok: true, stdout: '' };
      return { ok: true, stdout: '' };
    };

    const result = await collectDesignDiff('/worktree', run);

    expect(result.baseRef).toBe('origin/master');
  });

  it('returns skipReason when neither base ref resolves', async () => {
    const run: DiffRunner = async () => ({ ok: false, stdout: '' });

    const result = await collectDesignDiff('/worktree', run);

    expect(result.baseRef).toBeNull();
    expect(result.text).toBe('');
    expect(result.skipReason).toContain('origin/main');
    expect(result.skipReason).toContain('origin/master');
    expect(BASE_REF_CANDIDATES).toEqual(['origin/main', 'origin/master']);
  });

  it('appends uncommitted changes under a header when git diff HEAD is non-empty', async () => {
    const run: DiffRunner = async (argv) => {
      if (argv[1] === 'rev-parse') return { ok: true, stdout: '' };
      if (argv.includes('origin/main...HEAD')) return { ok: true, stdout: 'committed diff\n' };
      if (argv.includes('HEAD') && argv[1] === 'diff') return { ok: true, stdout: 'uncommitted diff\n' };
      return { ok: true, stdout: '' };
    };

    const result = await collectDesignDiff('/worktree', run);

    expect(result.text).toContain('committed diff');
    expect(result.text).toContain('### Uncommitted changes in the worktree');
    expect(result.text).toContain('uncommitted diff');
  });

  it('sets truncated and appends the marker past MAX_DIFF_CHARS', async () => {
    const big = 'x'.repeat(MAX_DIFF_CHARS + 500);
    const run: DiffRunner = async (argv) => {
      if (argv[1] === 'rev-parse') return { ok: true, stdout: '' };
      if (argv.includes('origin/main...HEAD')) return { ok: true, stdout: big };
      return { ok: true, stdout: '' };
    };

    const result = await collectDesignDiff('/worktree', run);

    expect(result.truncated).toBe(true);
    expect(result.text).toContain(`[diff truncated at ${MAX_DIFF_CHARS} characters]`);
  });

  it('origin/main outranks the captured base', { timeout: 120_000 }, async () => {
    const { worktree, baseSha } = await makeRemoteLessGitRepo();
    await execFile('git', ['update-ref', 'refs/remotes/origin/main', baseSha], { cwd: worktree });
    await writeFile(join(worktree, 'second.ts'), 'export const second = true;\n');
    await execFile('git', ['add', '.'], { cwd: worktree });
    await execFile('git', ['commit', '-m', 'second'], { cwd: worktree });
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: worktree });
    const otherSha = stdout.trim();
    expect(otherSha).not.toBe(baseSha);

    const result = await collectDesignDiff(worktree, undefined, { fallbackBaseRef: otherSha });

    expect(result.baseRef).toBe('origin/main');
    expect(result.skipReason).toBeUndefined();
  });

  it('returns text: "" when both diffs are empty', async () => {
    const run: DiffRunner = async (argv) => {
      if (argv[1] === 'rev-parse') return { ok: true, stdout: '' };
      return { ok: true, stdout: '' };
    };

    const result = await collectDesignDiff('/worktree', run);

    expect(result.text).toBe('');
    expect(result.truncated).toBe(false);
  });
});

describe('captureDiffBase', () => {
  it('returns the trimmed HEAD SHA on success', async () => {
    const calls: string[][] = [];
    const run: DiffRunner = async (argv) => {
      calls.push([...argv]);
      return { ok: true, stdout: 'abc123def\n' };
    };

    await expect(captureDiffBase('/worktree', run)).resolves.toBe('abc123def');
    expect(calls[0]).toEqual(['git', 'rev-parse', 'HEAD']);
  });

  it('returns undefined when git rev-parse HEAD fails', async () => {
    const run: DiffRunner = async () => ({ ok: false, stdout: '' });

    await expect(captureDiffBase('/worktree', run)).resolves.toBeUndefined();
  });

  it('returns undefined when the output is empty despite an ok exit', async () => {
    const run: DiffRunner = async () => ({ ok: true, stdout: '\n' });

    await expect(captureDiffBase('/worktree', run)).resolves.toBeUndefined();
  });
});

describe('designSmellsEnabled', () => {
  it('defaults to true', () => {
    expect(designSmellsEnabled({})).toBe(true);
  });

  it('is false when FACTORY_DESIGN_SMELLS=0', () => {
    expect(designSmellsEnabled({ FACTORY_DESIGN_SMELLS: '0' })).toBe(false);
  });

  it('is true when FACTORY_DESIGN_SMELLS=1', () => {
    expect(designSmellsEnabled({ FACTORY_DESIGN_SMELLS: '1' })).toBe(true);
  });
});

describe('workerOutputChecker', () => {
  it('fails when a collectable diff is empty', async () => {
    const result = await workerOutputChecker(makeContext('/worktree'), {
      collectDiff: async () => ({ text: '', baseRef: 'origin/main', truncated: false }),
    });

    expect(result).toEqual({
      checker: WORKER_OUTPUT_CHECKER,
      result: 'FAIL',
      details: 'worker produced no diff against origin/main; no implementation was produced',
    });
  });

  it('passes when a collectable diff has product changes', async () => {
    const result = await workerOutputChecker(makeContext('/worktree'), {
      collectDiff: async () => ({
        text: 'diff --git a/a.ts b/a.ts\n+export const changed = true;\n',
        baseRef: 'origin/main',
        truncated: false,
      }),
    });

    expect(result.checker).toBe(WORKER_OUTPUT_CHECKER);
    expect(result.result).toBe('PASS');
  });

  it('skips when no supported remote baseline can be collected', async () => {
    const result = await workerOutputChecker(makeContext('/worktree'), {
      collectDiff: async () => ({
        text: '',
        baseRef: null,
        truncated: false,
        skipReason: 'no base ref (tried origin/main, origin/master) — not a git checkout or no remote base',
      }),
    });

    expect(result.checker).toBe(WORKER_OUTPUT_CHECKER);
    expect(result.result).toBe('SKIP');
  });

  it(
    'workerOutputChecker passes against the run-start base when the worker committed',
    { timeout: 120_000 },
    async () => {
      const { worktree, baseSha } = await makeRemoteLessGitRepo();
      await mkdir(join(worktree, 'src'), { recursive: true });
      await writeFile(join(worktree, 'src', 'impl.ts'), 'export const implemented = true;\n');
      await execFile('git', ['add', '.'], { cwd: worktree });
      await execFile('git', ['commit', '-m', 'implement'], { cwd: worktree });

      const result = await workerOutputChecker(makeContext(worktree, { diffBase: baseSha }));

      expect(result.checker).toBe(WORKER_OUTPUT_CHECKER);
      expect(result.result).toBe('PASS');
      expect(result.details).toContain(baseSha);
    },
  );

  it('workerOutputChecker fails (not skips) when nothing changed since run start', { timeout: 120_000 }, async () => {
    const { worktree, baseSha } = await makeRemoteLessGitRepo();

    const result = await workerOutputChecker(makeContext(worktree, { diffBase: baseSha }));

    expect(result.checker).toBe(WORKER_OUTPUT_CHECKER);
    expect(result.result).not.toBe('SKIP');
    expect(result.result).toBe('FAIL');
    expect(result.details).toContain(baseSha);
    expect(result.details).toContain('no implementation was produced');
  });

  it(
    'workerOutputChecker skips with a reason naming the missing base when no base of any kind resolves',
    { timeout: 120_000 },
    async () => {
      const { worktree } = await makeRemoteLessGitRepo();

      const withoutFallback = await workerOutputChecker(makeContext(worktree));
      expect(withoutFallback.result).toBe('SKIP');
      expect(withoutFallback.details).toContain('no base ref (tried origin/main, origin/master)');

      const unverifiableFallback = await workerOutputChecker(makeContext(worktree, { diffBase: 'deadbeef' }));
      expect(unverifiableFallback.result).toBe('SKIP');
      expect(unverifiableFallback.details).toContain('no fallback base');
    },
  );
});

describe('buildDesignSmellPrompt', () => {
  const base = {
    worktree: '/worktree',
    diff: 'diff --git a/x.ts b/x.ts\n+const x = 1 as any;\n',
    truncated: false,
    baseRef: 'origin/main',
    specText: 'the frozen spec text',
    constitutionBody: 'the constitution body',
    adrCtx: '## Active architecture decisions (docs/adr)\n\nADR-0004 binding',
    designGrounding: '## Design grounding (from the frozen PLAN artifact)\n\ntarget types',
  };

  it('contains the diff, base ref, constitution body, ADR block and design grounding when supplied', () => {
    const prompt = buildDesignSmellPrompt(base);

    expect(prompt).toContain(base.diff);
    expect(prompt).toContain('DIFF BASE: origin/main');
    expect(prompt).toContain('the constitution body');
    expect(prompt).toContain('ADR-0004 binding');
    expect(prompt).toContain('target types');
  });

  it('omits empty ADR and design-grounding sections', () => {
    const prompt = buildDesignSmellPrompt({ ...base, adrCtx: '', designGrounding: '' });

    expect(prompt).not.toContain('Active architecture decisions');
    expect(prompt).not.toContain('Design grounding');
  });

  it('states the truncation when truncated', () => {
    const prompt = buildDesignSmellPrompt({ ...base, truncated: true });

    expect(prompt).toContain('diff truncated');
  });

  it('names all four kinds from SMELL_KINDS', () => {
    const prompt = buildDesignSmellPrompt(base);

    for (const kind of SMELL_KINDS) {
      expect(prompt).toContain(kind);
    }
  });
});

describe('parseDesignSmellVerdict', () => {
  it('parses a valid verdict', () => {
    const { verdict, rejected, reason } = parseDesignSmellVerdict(
      '{"checker":"design_smells","result":"PASS","smells":[]}',
    );

    expect(reason).toBeUndefined();
    expect(rejected).toEqual([]);
    expect(verdict?.result).toBe('PASS');
    expect(verdict?.smells).toEqual([]);
  });

  it('parses a verdict embedded in prose', () => {
    const { verdict } = parseDesignSmellVerdict(
      'Here is my verdict:\n{"checker":"design_smells","result":"FAIL","smells":[]}\nDone.',
    );

    expect(verdict?.result).toBe('FAIL');
  });

  it('parses a verdict whose evidence contains braces', () => {
    const { verdict } = parseDesignSmellVerdict(
      '{"checker":"design_smells","result":"FAIL","smells":[{"kind":"cast-to-pass","file":"a.ts","evidence":"casts as { foo: 1 }","suggestion":"fix the type"}]}',
    );

    expect(verdict?.smells[0]?.evidence).toContain('{ foo: 1 }');
  });

  it('returns null with a reason on a wrong checker value', () => {
    const { verdict, rejected, reason } = parseDesignSmellVerdict(
      '{"checker":"not_design_smells","result":"PASS","smells":[]}',
    );

    expect(verdict).toBeNull();
    expect(rejected).toEqual([]);
    expect(reason).toContain('malformed verdict');
  });

  it('returns null with a reason when there is no JSON', () => {
    const { verdict, reason } = parseDesignSmellVerdict('I could not determine anything.');

    expect(verdict).toBeNull();
    expect(reason).toContain('no valid JSON');
  });

  it('salvages valid elements and reports invalid ones when the array is mixed', () => {
    const output = JSON.stringify({
      checker: 'design_smells',
      result: 'FAIL',
      smells: [
        smell({ file: 'a.ts' }),
        { kind: 'cast_to_pass', file: 'b.ts', evidence: 'e', suggestion: 's' },
        smell({ file: 'c.ts', suggestion: '' }),
      ],
    });

    const { verdict, rejected } = parseDesignSmellVerdict(output);

    expect(verdict).not.toBeNull();
    expect(verdict?.result).toBe('FAIL');
    expect(verdict?.smells.map((s) => s.file)).toEqual(['a.ts']);
    expect(rejected).toHaveLength(2);
    expect(rejected[0]).toMatchObject({ index: 1 });
    expect(rejected[0]!.errors.join(' ')).toContain('kind');
    expect(rejected[1]).toMatchObject({ index: 2 });
    expect(rejected[1]!.errors.join(' ')).toContain('suggestion');
  });

  it('salvages nothing but still returns a verdict when every element is invalid', () => {
    const output = JSON.stringify({
      checker: 'design_smells',
      result: 'FAIL',
      smells: [
        { kind: 'cast_to_pass', file: 'a.ts', evidence: 'e', suggestion: 's' },
        { kind: 'cast-to-pass', file: '', evidence: 'e', suggestion: 's' },
      ],
    });

    const { verdict, rejected } = parseDesignSmellVerdict(output);

    expect(verdict).not.toBeNull();
    expect(verdict?.smells).toEqual([]);
    expect(rejected).toHaveLength(2);
  });

  it('treats an omitted or null smells field as empty with nothing rejected', () => {
    const omitted = parseDesignSmellVerdict('{"checker":"design_smells","result":"PASS"}');
    const nulled = parseDesignSmellVerdict('{"checker":"design_smells","result":"PASS","smells":null}');

    for (const { verdict, rejected } of [omitted, nulled]) {
      expect(verdict?.smells).toEqual([]);
      expect(rejected).toEqual([]);
    }
  });

  it('fails closed when smells is present but not an array', () => {
    const { verdict, reason } = parseDesignSmellVerdict('{"checker":"design_smells","result":"PASS","smells":"lots"}');

    expect(verdict).toBeNull();
    expect(reason).toContain('malformed verdict');
  });

  it('rejects a non-object smells element without a stray leading colon', () => {
    const { rejected } = parseDesignSmellVerdict('{"checker":"design_smells","result":"FAIL","smells":[42]}');

    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.errors[0]).not.toMatch(/^:/);
    expect(rejected[0]!.errors[0]).toContain('expected object');
  });
});

describe('renderSmellDetails', () => {
  it('renders [kind] file:line — evidence → suggested: ...', () => {
    const rendered = renderSmellDetails([smell()]);

    expect(rendered).toContain('[cast-to-pass] packages/core/src/a.ts:42');
    expect(rendered).toContain('casts result as any to satisfy the return type');
    expect(rendered).toContain('suggested: change the return type to include undefined');
  });

  it('omits :line when absent', () => {
    const rendered = renderSmellDetails([smell({ line: undefined })]);

    expect(rendered).toContain('packages/core/src/a.ts —');
    expect(rendered).not.toMatch(/a\.ts:\d/);
  });

  it('truncates long fields', () => {
    const rendered = renderSmellDetails([smell({ evidence: 'x'.repeat(500), suggestion: 'y'.repeat(500) })]);

    expect(rendered).toContain('…');
    expect(rendered.length).toBeLessThan(1200);
  });

  it('caps at MAX_SMELLS_RENDERED and reports (N more)', () => {
    const smells = Array.from({ length: MAX_SMELLS_RENDERED + 3 }, (_, i) => smell({ file: `f${i}.ts` }));

    const rendered = renderSmellDetails(smells);

    expect(rendered).toContain(`${smells.length} program-design smell(s)`);
    expect(rendered).toContain('(3 more)');
  });
});

describe('renderRejectedSmells', () => {
  function rejectedSmell(overrides: Partial<RejectedSmell> = {}): RejectedSmell {
    return { index: 0, errors: ['kind: Invalid enum value'], ...overrides };
  }

  it('renders the dropped count, index and zod message', () => {
    const rendered = renderRejectedSmells([rejectedSmell({ index: 2, errors: ['kind: Invalid enum value'] })]);

    expect(rendered).toContain('1 malformed smell element(s) dropped');
    expect(rendered).toContain('[2] kind: Invalid enum value');
  });

  it('caps at MAX_SMELLS_RENDERED and reports (N more)', () => {
    const rejected = Array.from({ length: MAX_SMELLS_RENDERED + 3 }, (_, i) => rejectedSmell({ index: i }));

    const rendered = renderRejectedSmells(rejected);

    expect(rendered).toContain(`${rejected.length} malformed smell element(s) dropped`);
    expect(rendered).toContain('(3 more)');
  });
});

describe('designSmellsChecker', () => {
  const cleanDiff = { text: 'diff --git a/x.ts b/x.ts\n+const x = 1;\n', baseRef: 'origin/main', truncated: false };

  it('fails the gate when a cast-to-pass smell is reported (rework-loop trigger)', async () => {
    const worktree = await makeWorktree();
    const { router, stub } = makeRouter(
      '{"checker":"design_smells","result":"FAIL","smells":[{"kind":"cast-to-pass","file":"packages/core/src/a.ts","line":42,"evidence":"casts as any to satisfy signature","suggestion":"widen the parameter type instead"}]}',
    );

    const result = await designSmellsChecker(makeContext(worktree), router, undefined, {
      collectDiff: async () => cleanDiff,
    });

    expect(result.checker).toBe(DESIGN_SMELLS_CHECKER);
    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('packages/core/src/a.ts:42');
    expect(result.details).toContain('widen the parameter type instead');
    expect(stub.calls[0].prompt).toContain('test constitution');
  });

  it('passes on a clean verdict with no smells', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker":"design_smells","result":"PASS","smells":[]}');

    const result = await designSmellsChecker(makeContext(worktree), router, undefined, {
      collectDiff: async () => cleanDiff,
    });

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('no program-design smells found');
  });

  it('skips when FACTORY_DESIGN_SMELLS=0', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker":"design_smells","result":"PASS","smells":[]}');

    const result = await designSmellsChecker(makeContext(worktree), router, undefined, {
      collectDiff: async () => cleanDiff,
      env: { FACTORY_DESIGN_SMELLS: '0' },
    });

    expect(result.result).toBe('SKIP');
    expect(result.details).toContain('FACTORY_DESIGN_SMELLS=0');
  });

  it('skips on a skipReason from the collector', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker":"design_smells","result":"PASS","smells":[]}');

    const result = await designSmellsChecker(makeContext(worktree), router, undefined, {
      collectDiff: async () => ({ text: '', baseRef: null, truncated: false, skipReason: 'no base ref' }),
    });

    expect(result.result).toBe('SKIP');
    expect(result.details).toBe('no base ref');
  });

  it('skips on an empty diff', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker":"design_smells","result":"PASS","smells":[]}');

    const result = await designSmellsChecker(makeContext(worktree), router, undefined, {
      collectDiff: async () => ({ text: '', baseRef: 'origin/main', truncated: false }),
    });

    expect(result.result).toBe('SKIP');
    expect(result.details).toContain('nothing to critique');
  });

  it('skips naming the error when the router throws', async () => {
    const worktree = await makeWorktree();
    const stub = new StubModelExecutor({ scripts: { check_design: [{ fail: 'error' }] } });
    const router = new ModelRouter(models, routes, false, stub);

    const result = await designSmellsChecker(makeContext(worktree), router, undefined, {
      collectDiff: async () => cleanDiff,
    });

    expect(result.result).toBe('SKIP');
    expect(result.details).toContain('design critic unavailable');
    expect(result.details).toContain('error');
  });

  it('fails closed when the critic output is unparsable', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('I could not determine anything.');

    const result = await designSmellsChecker(makeContext(worktree), router, undefined, {
      collectDiff: async () => cleanDiff,
    });

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('no valid JSON');
  });

  it('fails closed when the verdict envelope is malformed', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker":"not_design_smells","result":"PASS","smells":[]}');

    const result = await designSmellsChecker(makeContext(worktree), router, undefined, {
      collectDiff: async () => cleanDiff,
    });

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('malformed verdict');
  });

  it('fails and salvages valid findings when the smells array is mixed valid/invalid (headline case)', async () => {
    const worktree = await makeWorktree();
    const output = JSON.stringify({
      checker: 'design_smells',
      result: 'FAIL',
      smells: [
        smell({ file: 'packages/core/src/a.ts', suggestion: 'widen the parameter type instead' }),
        { kind: 'cast_to_pass', file: 'b.ts', evidence: 'e', suggestion: 's' },
      ],
    });
    const { router } = makeRouter(output);

    const result = await designSmellsChecker(makeContext(worktree), router, undefined, {
      collectDiff: async () => cleanDiff,
    });

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('packages/core/src/a.ts');
    expect(result.details).toContain('widen the parameter type instead');
    expect(result.details).toContain('malformed smell element(s) dropped');
  });

  it('fails with "no usable findings" when every smell element is invalid', async () => {
    const worktree = await makeWorktree();
    const output = JSON.stringify({
      checker: 'design_smells',
      result: 'FAIL',
      smells: [{ kind: 'cast_to_pass', file: 'a.ts', evidence: 'e', suggestion: 's' }],
    });
    const { router } = makeRouter(output);

    const result = await designSmellsChecker(makeContext(worktree), router, undefined, {
      collectDiff: async () => cleanDiff,
    });

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('no usable findings');
  });

  it('still fails when a rejected element accompanies a PASS verdict', async () => {
    const worktree = await makeWorktree();
    const output = JSON.stringify({
      checker: 'design_smells',
      result: 'PASS',
      smells: [{ kind: 'cast_to_pass', file: 'a.ts', evidence: 'e', suggestion: 's' }],
    });
    const { router } = makeRouter(output);

    const result = await designSmellsChecker(makeContext(worktree), router, undefined, {
      collectDiff: async () => cleanDiff,
    });

    expect(result.result).toBe('FAIL');
  });

  it('all-valid smells still fail with no rejection note in details', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter(
      '{"checker":"design_smells","result":"FAIL","smells":[{"kind":"cast-to-pass","file":"a.ts","evidence":"e","suggestion":"s"}]}',
    );

    const result = await designSmellsChecker(makeContext(worktree), router, undefined, {
      collectDiff: async () => cleanDiff,
    });

    expect(result.result).toBe('FAIL');
    expect(result.details).not.toContain('malformed');
  });

  it('passes with a mismatch note when result is FAIL but smells is empty', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker":"design_smells","result":"FAIL","smells":[]}');

    const result = await designSmellsChecker(makeContext(worktree), router, undefined, {
      collectDiff: async () => cleanDiff,
    });

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('not actionable');
  });

  it('fails with a truncation note when the diff was truncated and findings exist', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter(
      '{"checker":"design_smells","result":"FAIL","smells":[{"kind":"swallowed-error","file":"a.ts","evidence":"empty catch","suggestion":"rethrow or log"}]}',
    );

    const result = await designSmellsChecker(makeContext(worktree), router, undefined, {
      collectDiff: async () => ({ ...cleanDiff, truncated: true }),
    });

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('diff was truncated');
  });

  it('designSmellsChecker prompts with DIFF BASE = captured SHA', { timeout: 120_000 }, async () => {
    const { worktree, baseSha } = await makeRemoteLessGitRepo();
    // Excluded churn lives in nested paths (module-adjacent __pycache__ etc.):
    // the ':!**/…' pathspecs in DIFF_EXCLUDES only match paths with a directory
    // component, so root-level cache files are a separate (pre-existing) gap.
    await writeFile(join(worktree, 'app.py'), 'def handler():\n    return "changed"\n');
    await mkdir(join(worktree, 'pkg', '__pycache__'), { recursive: true });
    await writeFile(join(worktree, 'pkg', '__pycache__', 'app.cpython-311.pyc'), 'bytecode');
    await writeFile(join(worktree, 'pkg', 'mod.pyc'), 'bytecode');
    await mkdir(join(worktree, 'pkg', '.pytest_cache'), { recursive: true });
    await writeFile(
      join(worktree, 'pkg', '.pytest_cache', 'CACHEDIR.TAG'),
      'Signature: 8a477f597d28d172789f06886806bc55',
    );
    await execFile('git', ['add', '-A'], { cwd: worktree });
    await execFile('git', ['commit', '-m', 'python change plus cache churn'], { cwd: worktree });

    const { router, stub } = makeRouter('{"checker":"design_smells","result":"PASS","smells":[]}');

    const result = await designSmellsChecker(makeContext(worktree, { diffBase: baseSha }), router);

    expect(result.result).toBe('PASS');
    expect(stub.calls).toHaveLength(1);
    const prompt = stub.calls[0].prompt;
    expect(prompt).toContain(`DIFF BASE: ${baseSha}`);
    expect(prompt).toContain('app.py');
    expect(prompt).toContain('return "changed"');
    expect(prompt).not.toContain('__pycache__');
    expect(prompt).not.toContain('.pyc');
    expect(prompt).not.toContain('.pytest_cache');
  });

  it(
    'skips with a reason naming the missing base when no base of any kind resolves',
    { timeout: 120_000 },
    async () => {
      const { worktree } = await makeRemoteLessGitRepo();
      const { router, stub } = makeRouter('{"checker":"design_smells","result":"PASS","smells":[]}');

      const withoutFallback = await designSmellsChecker(makeContext(worktree), router);
      expect(withoutFallback.result).toBe('SKIP');
      expect(withoutFallback.details).toContain('no base ref (tried origin/main, origin/master)');

      const unverifiableFallback = await designSmellsChecker(makeContext(worktree, { diffBase: 'deadbeef' }), router);
      expect(unverifiableFallback.result).toBe('SKIP');
      expect(unverifiableFallback.details).toContain('no fallback base');

      expect(stub.calls).toHaveLength(0);
    },
  );

  it('sends a prompt containing the constitution body and the diff', async () => {
    const worktree = await makeWorktree();
    const { router, stub } = makeRouter('{"checker":"design_smells","result":"PASS","smells":[]}');

    await designSmellsChecker(
      makeContext(worktree, { constitutionBody: 'unique constitution marker' }),
      router,
      undefined,
      {
        collectDiff: async () => cleanDiff,
      },
    );

    expect(stub.calls[0].prompt).toContain('unique constitution marker');
    expect(stub.calls[0].prompt).toContain(cleanDiff.text);
  });
});
