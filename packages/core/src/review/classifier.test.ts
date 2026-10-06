import { describe, expect, it, vi } from 'vitest';

import { collectDesignDiff, type DiffRunner } from '../checkers/design-smells.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { DEFAULT_REVIEW_FLOOR_RULES } from './floor.js';
import {
  buildClassifierPrompt,
  changedPathsFromDiff,
  CLASSIFIER_PROMPT_VERSION,
  classifierPolicyVersion,
  classifyPrShadow,
  parseClassifierOutput,
  toClassificationRecord,
  type PrShadowInput,
} from './classifier.js';

const MODELS: ModelsConfig = {
  version: 1,
  models: {
    'm-1': {
      provider: 'custom',
      tier: 'checker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { checker: ['m-1'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};
const ROUTES: RoutesConfig = { version: 1, routes: { classify_pr: { tier: 'checker', description: 'stub' } } };

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '+DIFF-BODY-SENTINEL',
  'diff --git a/docs/b.md b/docs/b.md',
  '+more',
].join('\n');

const VALID = JSON.stringify({
  class: 'C',
  claims: [
    { text: 'touches a.ts', citation: 'src/a.ts:12' },
    { text: 'range', citation: 'src/a.ts:3-9' },
    { text: 'per ADR', citation: 'ADR-0121' },
    { text: 'no citation' },
    { text: 'vague', citation: 'see above' },
  ],
  notInspected: ['tests'],
});

function makeRouter(output: string | Error) {
  const run = vi.fn(async () => {
    if (output instanceof Error) throw output;
    return { model: 'm-1', output, exitCode: 0, attempts: [] };
  });
  const router = new ModelRouter(MODELS, ROUTES, false, new StubModelExecutor({ scripts: {} }));
  vi.spyOn(router, 'run').mockImplementation(run);
  vi.spyOn(router.registryRef, 'estimateCost').mockReturnValue(0.01);
  return { router, run };
}

function input(router: ModelRouter, extra: Partial<PrShadowInput> = {}): PrShadowInput {
  return {
    worktree: '/w',
    issueTitle: 'ISSUE-TITLE-SENTINEL',
    issueBody: 'ISSUE-BODY-SENTINEL',
    specPath: '/spec.md',
    floor: 'A',
    floorRules: [],
    rules: DEFAULT_REVIEW_FLOOR_RULES,
    router,
    ...extra,
  };
}

const deps = {
  collectDiff: (async () => ({ text: DIFF, baseRef: 'origin/main', truncated: false })) as typeof collectDesignDiff,
  readFile: async () => 'SPEC-SENTINEL',
  readAdrs: async () => ({
    dir: 'docs/adr',
    active: [{ number: 121, title: 't', status: 'Accepted', date: '', path: 'p', decision: 'd' }],
    skipped: [],
    truncated: 0,
    scanned: 1,
  }),
};

describe('classifyPrShadow', () => {
  it('records a cited verdict with versions, sha, adrs and cost; final class is the floor', async () => {
    const { router, run } = makeRouter(VALID);
    const v = await classifyPrShadow(input(router), deps);
    expect(v.modelClass).toBe('C');
    expect(v.floorClass).toBe('A');
    expect(v.finalClass).toBe('A');
    expect(v.model).toBe('m-1');
    expect(v.claims.map((c) => c.citation)).toEqual(['src/a.ts:12', 'src/a.ts:3-9', 'ADR-0121']);
    expect(v.unsupportedClaims.map((c) => c.text)).toEqual(['no citation', 'vague']);
    expect(v.notInspected).toEqual(['tests']);
    expect(v.promptVersion).toBe(CLASSIFIER_PROMPT_VERSION);
    expect(v.policyVersion).toMatch(/^floor-[0-9a-f]{12}$/);
    expect(v.diffSha).toMatch(/^[0-9a-f]{64}$/);
    expect(v.adrIds).toEqual(['ADR-0121']);
    expect(v.costUsd).toBe(0.01);
    expect(run).toHaveBeenCalledTimes(1);
    expect(toClassificationRecord(v)).toEqual(v);
  });

  it('passes the pin as modelOverride and omits it otherwise', async () => {
    const pinned = makeRouter(VALID);
    await classifyPrShadow(input(pinned.router, { modelPin: 'pin-model' }), deps);
    expect(pinned.run).toHaveBeenCalledWith(
      'classify_pr',
      expect.any(String),
      expect.objectContaining({ modelOverride: 'pin-model' }),
    );
    const plain = makeRouter(VALID);
    await classifyPrShadow(input(plain.router), deps);
    const opts = (plain.run.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect('modelOverride' in opts).toBe(false);
  });

  it.each([
    ['malformed JSON', '{"class": "C", '],
    ['no JSON', 'I think it is C'],
    ['unknown class', '{"class":"D"}'],
  ])('%s gives a null class with a reason and does not throw', async (_n, output) => {
    const { router } = makeRouter(output);
    const v = await classifyPrShadow(input(router), deps);
    expect(v.modelClass).toBeNull();
    expect(v.reason).toBeTruthy();
    expect(v.model).toBe('m-1');
    expect(v.finalClass).toBe('A');
  });

  it('records a thrown call as null with a reason', async () => {
    const { router } = makeRouter(new Error('timeout after 600s'));
    const v = await classifyPrShadow(input(router), deps);
    expect(v.modelClass).toBeNull();
    expect(v.reason).toBe('classifier call failed: timeout after 600s');
    expect(v.diffSha).not.toBeNull();
  });

  it('does not call the model without a diff', async () => {
    const skip = makeRouter(VALID);
    const v1 = await classifyPrShadow(input(skip.router), {
      ...deps,
      collectDiff: (async () => ({
        text: '',
        baseRef: null,
        truncated: false,
        skipReason: 'no base',
      })) as typeof collectDesignDiff,
    });
    expect(v1.reason).toBe('no diff: no base');
    const empty = makeRouter(VALID);
    const v2 = await classifyPrShadow(input(empty.router), {
      ...deps,
      collectDiff: (async () => ({ text: '', baseRef: 'x', truncated: false })) as typeof collectDesignDiff,
    });
    expect(v2.reason).toBe('no diff to classify');
    expect(skip.run).not.toHaveBeenCalled();
    expect(empty.run).not.toHaveBeenCalled();
  });

  it('survives unexpected failures and falls back when spec/ADRs are unreadable', async () => {
    const { router, run } = makeRouter(VALID);
    const v = await classifyPrShadow(input(router), {
      ...deps,
      readFile: async () => {
        throw new Error('enoent');
      },
      readAdrs: async () => {
        throw new Error('bad adr');
      },
    });
    expect(v.modelClass).toBe('C');
    expect(v.adrIds).toEqual([]);
    expect((run.mock.calls[0] as unknown[])[1]).toContain('(no spec)');

    const boom = await classifyPrShadow(input(router), {
      ...deps,
      collectDiff: (async () => {
        throw new Error('git exploded');
      }) as typeof collectDesignDiff,
    });
    expect(boom.modelClass).toBeNull();
    expect(boom.reason).toContain('git exploded');
  });

  it('sends only diff, issue, spec and floor — never git log/show or PR prose', async () => {
    const argvs: string[][] = [];
    const runner: DiffRunner = async (argv) => {
      argvs.push([...argv]);
      const sub = argv[1];
      if (sub === 'log' || sub === 'show') return { ok: true, stdout: 'COMMIT-MSG-SENTINEL' };
      if (argv[0] === 'gh') return { ok: true, stdout: 'PR-BODY-SENTINEL' };
      if (sub === 'rev-parse') return { ok: true, stdout: 'abc' };
      if (sub === 'diff') return { ok: true, stdout: DIFF };
      return { ok: true, stdout: '' };
    };
    const { router, run } = makeRouter(VALID);
    await classifyPrShadow(input(router), {
      ...deps,
      collectDiff: (w, _r, o) => collectDesignDiff(w, runner, o),
    });
    const prompt = (run.mock.calls[0] as unknown[])[1] as string;
    for (const s of ['DIFF-BODY-SENTINEL', 'ISSUE-TITLE-SENTINEL', 'ISSUE-BODY-SENTINEL', 'SPEC-SENTINEL']) {
      expect(prompt).toContain(s);
    }
    expect(prompt).not.toContain('PR-BODY-SENTINEL');
    expect(prompt).not.toContain('COMMIT-MSG-SENTINEL');
    for (const argv of argvs) {
      expect(argv).not.toContain('log');
      expect(argv).not.toContain('show');
      expect(argv[0]).not.toBe('gh');
    }
  });
});

describe('parseClassifierOutput', () => {
  it('drops malformed claim elements, counts them, and keeps siblings', () => {
    const r = parseClassifierOutput(
      JSON.stringify({ class: 'B', claims: [{ text: '' }, 7, { text: 'ok', citation: 'a.ts:1' }] }),
    );
    expect(r).toMatchObject({ ok: true, class: 'B', droppedClaims: 2 });
    if (r.ok) expect(r.claims).toHaveLength(1);
  });

  it('defaults missing claims and notInspected', () => {
    expect(parseClassifierOutput('prose {"class":"A"} tail')).toMatchObject({
      ok: true,
      claims: [],
      notInspected: [],
    });
  });

  it('skips JSON objects without a class key', () => {
    expect(parseClassifierOutput('{"x":1} {"class":"A"}')).toMatchObject({ ok: true, class: 'A' });
  });
});

describe('buildClassifierPrompt', () => {
  it('renders every section, the floor rules and the truncation note', () => {
    const p = buildClassifierPrompt({
      diff: 'D',
      truncated: true,
      issueTitle: 'T',
      issueBody: 'B',
      specText: 'S',
      designGrounding: 'GROUND',
      adrCtx: 'ADRCTX',
      floor: 'B',
      floorRules: [{ id: 'r1', class: 'B', paths: ['a', 'b'] }],
    });
    for (const s of [
      '## Issue',
      '## Deterministic floor',
      'Floor class: B',
      '- r1 (B): a, b',
      'ADRCTX',
      '## Frozen design',
      '## Frozen spec',
      '## Diff',
      'diff truncated',
    ]) {
      expect(p).toContain(s);
    }
    const none = buildClassifierPrompt({
      diff: 'D',
      truncated: false,
      issueTitle: 'T',
      issueBody: 'B',
      specText: 'S',
      designGrounding: '',
      adrCtx: '',
      floor: null,
      floorRules: [],
    });
    expect(none).toContain('Floor class: unavailable');
    expect(none).toContain('Fired rules: none');
    expect(none).not.toContain('## Frozen design');
  });
});

describe('helpers', () => {
  it('changedPathsFromDiff dedupes and sorts b-paths', () => {
    expect(changedPathsFromDiff(DIFF + '\ndiff --git a/src/a.ts b/src/a.ts')).toEqual(['docs/b.md', 'src/a.ts']);
  });

  it('classifierPolicyVersion is stable for equal rules and changes with them', () => {
    const rules = DEFAULT_REVIEW_FLOOR_RULES;
    expect(classifierPolicyVersion(rules)).toBe(classifierPolicyVersion(structuredClone(rules)));
    expect(classifierPolicyVersion({ ...rules, maxLines: rules.maxLines + 1 })).not.toBe(
      classifierPolicyVersion(rules),
    );
  });
});
