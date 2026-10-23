import { describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { buildDecompositionPrompt, decomposeOversizedIssue, parseDecompositionOutput } from './decompose.js';

const story = (n: number) => ({
  title: `Story ${n}`,
  role: 'operator',
  want: `thing ${n} works`,
  soThat: 'value',
  problemStatement: `Problem ${n}`,
  inScope: [`scope ${n}`],
  outOfScope: ['other'],
  acceptanceCriteria: [{ name: `ac ${n}`, given: [], when: ['run'], then: ['works'] }],
  verification: [{ command: 'npm test', passWhen: 'passes' }],
  tracesTo: ['INT-PROBLEM-01'],
});

const VALID_DECOMPOSITION_JSON = JSON.stringify({
  epic: { title: 'Epic', why: 'why', doneWhen: ['done'], children: ['Story 1', 'Story 2'] },
  stories: [story(1), story(2)],
});

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'triage',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { triage: ['stub-model'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

const routes: RoutesConfig = { version: 1, routes: { decompose: { tier: 'triage', description: 'stub' } } };

describe('filesLikelyTouched (#3351)', () => {
  const withFiles = (files: unknown): string => {
    const parsed = JSON.parse(VALID_DECOMPOSITION_JSON);
    if (files === undefined) delete parsed.stories[0].filesLikelyTouched;
    else parsed.stories[0].filesLikelyTouched = files;
    return JSON.stringify(parsed);
  };

  it('parseDecompositionOutput carries normalized filesLikelyTouched', () => {
    const result = parseDecompositionOutput(withFiles(['./a.ts', 'a.ts', '', '  ', ' b.ts ']));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decomposition.stories[0].filesLikelyTouched).toEqual(['a.ts', 'b.ts']);
  });

  it('parseDecompositionOutput defaults a missing or non-array filesLikelyTouched to [] without failing', () => {
    for (const value of [undefined, 'src/a.ts', null, { a: 1 }]) {
      const result = parseDecompositionOutput(withFiles(value));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.decomposition.stories[0].filesLikelyTouched).toEqual([]);
    }
  });

  it('the prompt asks for filesLikelyTouched', () => {
    expect(buildDecompositionPrompt({ title: 't', body: 'b' })).toContain('filesLikelyTouched');
  });

  it('decomposeOversizedIssue keeps a cohesive decomposition whole: nothing posted or filed', async () => {
    const parsed = JSON.parse(VALID_DECOMPOSITION_JSON);
    for (const story of parsed.stories) story.filesLikelyTouched = ['src/a.ts', 'src/b.ts'];
    const stub = new StubModelExecutor({ scripts: { decompose: [{ output: JSON.stringify(parsed) }] } });
    const router = new ModelRouter(models, routes, false, stub);
    const createComment = vi.fn().mockResolvedValue({});
    const create = vi.fn();
    const octokit = { rest: { issues: { createComment, create } }, request: vi.fn() } as any;
    const events: { type: string; msg: string }[] = [];

    const result = await decomposeOversizedIssue({
      issue: 3351,
      repo: 'on-par/software-factory',
      title: 't',
      body: 'b',
      worktree: '/tmp/wt',
      router,
      octokit,
      log: (type, msg) => events.push({ type, msg }),
      fileSubIssues: true,
    });

    expect(result.cohesive?.cohesive).toBe(true);
    expect(result.posted).toBe(false);
    expect(result.childIssues).toEqual([]);
    expect(createComment).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'size_gate_cohesive')?.msg).toContain('src/a.ts');
  });
});
