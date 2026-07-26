// src/checkers/design-smells.test.ts — CHECK-phase program-design smell critic (#483).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import {
  BASE_REF_CANDIDATES,
  buildDesignSmellPrompt,
  collectDesignDiff,
  DESIGN_SMELLS_CHECKER,
  type DesignSmell,
  designSmellsChecker,
  designSmellsEnabled,
  type DiffRunner,
  MAX_DIFF_CHARS,
  MAX_SMELLS_RENDERED,
  parseDesignSmellVerdict,
  renderSmellDetails,
  SMELL_KINDS,
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

async function makeWorktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'design-smells-test-'));
  tempDirs.add(dir);
  return dir;
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
      ]),
    );
    expect(committedCall!.cwd).toBe('/worktree');
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
    const { verdict, reason } = parseDesignSmellVerdict('{"checker":"design_smells","result":"PASS","smells":[]}');

    expect(reason).toBeUndefined();
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
    const { verdict, reason } = parseDesignSmellVerdict('{"checker":"not_design_smells","result":"PASS","smells":[]}');

    expect(verdict).toBeNull();
    expect(reason).toContain('malformed verdict');
  });

  it('returns null with a reason when there is no JSON', () => {
    const { verdict, reason } = parseDesignSmellVerdict('I could not determine anything.');

    expect(verdict).toBeNull();
    expect(reason).toContain('no valid JSON');
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

  it('skips when the critic output is unparsable', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('I could not determine anything.');

    const result = await designSmellsChecker(makeContext(worktree), router, undefined, {
      collectDiff: async () => cleanDiff,
    });

    expect(result.result).toBe('SKIP');
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
