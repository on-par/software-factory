import { describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import {
  checkParentCriteriaCoverage,
  decomposeOversizedIssue,
  parseDecompositionOutput,
  parseParentCriteria,
  renderChildIssueBody,
  validateDecomposition,
} from './decompose.js';
import type { DecompositionOutput } from './decompose.js';

const criterion = (name: string, tracesTo: string[]) => ({
  name,
  given: [],
  when: ['run'],
  then: ['works'],
  tracesTo,
});

const decompositionJson = (criteria: ReturnType<typeof criterion>[][]): string =>
  JSON.stringify({
    epic: { title: 'Epic', why: 'why', doneWhen: ['done'], children: criteria.map((_, i) => `Story ${i + 1}`) },
    stories: criteria.map((acceptanceCriteria, i) => ({
      title: `Story ${i + 1}`,
      role: 'operator',
      want: `thing ${i + 1} works`,
      soThat: 'value',
      problemStatement: 'problem',
      inScope: [`scope ${i + 1}`],
      outOfScope: ['other'],
      acceptanceCriteria,
      verification: [{ command: 'npm test', passWhen: 'passes' }],
      tracesTo: ['INT-PROBLEM-01'],
    })),
  });

const decompose = (criteria: ReturnType<typeof criterion>[][]): DecompositionOutput => {
  const parsed = parseDecompositionOutput(decompositionJson(criteria));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.decomposition;
};

const PARENT = [
  { id: 'P1', text: 'one' },
  { id: 'P2', text: 'two' },
  { id: 'P3', text: 'three' },
];

describe('parseParentCriteria', () => {
  it('gives each checkbox a P<position> id', () => {
    const body = '## Acceptance criteria\n- [ ] first\n- [ ] second\n- [ ] third\n\n## Verification\nnpm test';
    expect(parseParentCriteria(body)).toEqual([
      { id: 'P1', text: 'first' },
      { id: 'P2', text: 'second' },
      { id: 'P3', text: 'third' },
    ]);
  });

  it('skips an empty box but keeps later ids stable', () => {
    const body = '## Acceptance criteria\n- [ ] first\n- [ ]\n- [ ] third';
    expect(parseParentCriteria(body).map((c) => c.id)).toEqual(['P1', 'P3']);
  });

  it('returns [] when there is no acceptance criteria section', () => {
    expect(parseParentCriteria('## Problem statement\nNothing here')).toEqual([]);
  });
});

describe('parseDecompositionOutput criterion traces (#3105)', () => {
  it('accepts a criterion tracing both INT-PROBLEM-01 and P1', () => {
    const parsed = parseDecompositionOutput(decompositionJson([[criterion('a', ['INT-PROBLEM-01', 'P1'])]]));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.decomposition.stories[0].acceptanceCriteria[0].tracesTo).toEqual(['INT-PROBLEM-01', 'P1']);
  });

  it('rejects a criterion tracing an issue number as a retryable failure', () => {
    const parsed = parseDecompositionOutput(decompositionJson([[criterion('a', ['#375'])]]));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('contracts schema');
  });
});

describe('validateDecomposition parent coverage (#3105)', () => {
  it('rejects a decomposition that leaves parent criterion P3 uncovered and names it', () => {
    const result = validateDecomposition(decompose([[criterion('a', ['P1'])], [criterion('b', ['P2'])]]), PARENT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.join('\n')).toContain('parent criterion P3 ("three")');
  });

  it('passes when every parent criterion is covered', () => {
    const result = validateDecomposition(decompose([[criterion('a', ['P1', 'P2'])], [criterion('b', ['P3'])]]), PARENT);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a child tracing a parent criterion that does not exist', () => {
    const result = validateDecomposition(decompose([[criterion('a', ['P1', 'P2', 'P3', 'P9'])]]), PARENT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.join('\n')).toContain('unknown parent criterion P9');
  });

  it('is unchanged without parent criteria', () => {
    expect(validateDecomposition(decompose([[criterion('a', [])]]))).toEqual({ ok: true });
  });
});

describe('checkParentCriteriaCoverage', () => {
  it('reports uncovered criteria and unknown ids directly', () => {
    const { stories } = decompose([[criterion('a', ['P1', 'P7', 'P7'])]]);
    expect(checkParentCriteriaCoverage(PARENT, stories)).toEqual({
      ok: false,
      uncovered: [PARENT[1], PARENT[2]],
      unknownIds: ['P7'],
    });
  });
});

describe('renderChildIssueBody parent coverage line (#3105)', () => {
  it('renders a "Covers parent criteria: P1, P3" line for a child tracing P1 and P3', () => {
    const { stories } = decompose([[criterion('a', ['P3']), criterion('b', ['P1', 'INT-PROBLEM-01'])]]);
    const body = renderChildIssueBody(stories[0], 606);
    expect(body).toContain('Covers parent criteria: P1, P3\n');
    expect(body.indexOf('Covers parent criteria')).toBeLessThan(body.indexOf('Decomposed from #606'));
  });

  it('omits the line when no parent criterion is traced', () => {
    const { stories } = decompose([[criterion('a', ['INT-PROBLEM-01'])]]);
    expect(renderChildIssueBody(stories[0], 606)).not.toContain('Covers parent criteria');
  });

  it('with no parent issue (a brief slice, #3813) leaves out the "Decomposed from" line and the separator', () => {
    const { stories } = decompose([[criterion('a', ['P1'])], [criterion('b', ['INT-PROBLEM-01'])]]);
    const covered = renderChildIssueBody(stories[0]);
    expect(covered).toMatch(/---\n\nCovers parent criteria: P1$/);
    const bare = renderChildIssueBody(stories[1]);
    expect(bare).not.toMatch(/Decomposed from|#\d|---/);
    expect(bare.endsWith('passes when: passes')).toBe(true);
  });
});

describe('decomposeOversizedIssue parent coverage (#3105)', () => {
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
    failover: { triggers: ['rate_limit', 'unavailable', 'auth'], maxRetries: 2, cooldownMs: 0 },
    routingRules: {},
  };
  const routes: RoutesConfig = { version: 1, routes: { decompose: { tier: 'triage', description: 'stub' } } };

  it('retries with a prompt naming the uncovered criterion, then accepts full coverage', async () => {
    const stub = new StubModelExecutor({
      scripts: {
        decompose: [
          { output: decompositionJson([[criterion('a', ['P1', 'P2'])]]) },
          { output: decompositionJson([[criterion('a', ['P1', 'P2', 'P3'])]]) },
        ],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const run = vi.spyOn(router, 'run');
    const octokit = { rest: { issues: { createComment: vi.fn() } }, request: vi.fn() } as any;

    const result = await decomposeOversizedIssue({
      issue: 3105,
      repo: 'on-par/software-factory',
      title: 'Big',
      body: '## Acceptance criteria\n- [ ] one\n- [ ] two\n- [ ] three',
      worktree: '/tmp/wt',
      router,
      octokit,
      log: () => {},
      postComment: false,
    });

    expect(result.decomposition).toBeDefined();
    expect(run).toHaveBeenCalledTimes(2);
    const first = String(run.mock.calls[0][1]);
    expect(first).toContain('<untrusted-parent-criteria>');
    expect(first).toContain('P1: one');
    expect(String(run.mock.calls[1][1])).toContain('parent criterion P3 ("three")');
  });
});
