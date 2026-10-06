// packages/cli/src/cli/classifier-backtest.test.ts — factory classifier backtest (#1728)
import { ModelRouter, type FactoryEvent, type ModelsConfig, type RoutesConfig } from '@on-par/factory-core';
import { StubModelExecutor } from '@on-par/factory-core/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  cmdClassifierBacktest,
  ClassifierBacktestInputError,
  type ClassifierBacktestDeps,
  type ClassifierBacktestOptions,
} from './classifier-backtest.js';

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

function pr(n: number, mergedAt: string, sha = `abc${String(n).padStart(4, '0')}`) {
  return {
    number: n,
    head: { ref: `factory/${n}-x` },
    state: 'closed',
    merged_at: mergedAt,
    closed_at: mergedAt,
    merge_commit_sha: sha,
  };
}

function makeDeps(prs: any[], extra: Partial<ClassifierBacktestDeps> = {}) {
  const logs: string[] = [];
  const files = new Map<string, string>();
  const commands: string[] = [];
  const run = vi.fn(async () => ({
    model: 'm-1',
    output: '{"class":"A","claims":[],"notInspected":[]}',
    exitCode: 0,
    attempts: [],
  }));
  const router = new ModelRouter(MODELS, ROUTES, false, new StubModelExecutor({ scripts: {} }));
  vi.spyOn(router, 'run').mockImplementation(run);
  vi.spyOn(router.registryRef, 'estimateCost').mockReturnValue(0.4);
  const octokit = {
    rest: {
      pulls: {
        list: vi.fn().mockResolvedValue({ data: prs }),
        get: vi.fn().mockResolvedValue({ data: { merged_by: { login: 'bob' } } }),
        listCommits: vi.fn().mockResolvedValue({ data: [] }),
        listReviews: vi.fn().mockResolvedValue({ data: [] }),
      },
      issues: {
        get: vi.fn().mockResolvedValue({ data: { title: 'T', body: 'B' } }),
        listForRepo: vi.fn().mockResolvedValue({ data: [] }),
        listComments: vi.fn().mockResolvedValue({ data: [] }),
      },
      repos: { listCommits: vi.fn().mockResolvedValue({ data: [] }) },
    },
  } as any;
  const deps: ClassifierBacktestDeps = {
    repoRoot: '/repo',
    paths: {
      state: '/repo/.factory/state',
      plans: '/repo/.factory/state/plans',
      events: '/repo/.factory/events.ndjson',
    } as any,
    owner: 'o',
    repo: 'r',
    octokit,
    router,
    rules: { maxLines: 500, maxFiles: 20, rules: [] } as any,
    windowDays: 14,
    exec: async (cmd) => {
      commands.push(cmd);
      return { stdout: cmd.includes('--numstat') ? '3\t1\tdocs/a.md\n' : 'diff --git a/docs/a.md b/docs/a.md\n' };
    },
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    appendFile: (p, t) => files.set(p, (files.get(p) ?? '') + t),
    ensureDir: () => {},
    readEvents: () => [] as FactoryEvent[],
    now: () => '2026-10-05T00:00:00.000Z',
    log: (l) => logs.push(l),
    ...extra,
  };
  const jsonl = () => {
    const [name] = [...files.keys()].filter((k) => k.includes('classifier-backtest-'));
    return name
      ? files
          .get(name)!
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  };
  return { deps, logs, files, commands, jsonl, run };
}

const opts = (o: Partial<ClassifierBacktestOptions> = {}): ClassifierBacktestOptions => ({
  since: '2026-08-01',
  branchPrefix: 'factory',
  ...o,
});
const PRS = [1, 2, 3, 4].map((n) => pr(n, `2026-08-0${n}T00:00:00.000Z`));

describe('cmdClassifierBacktest', () => {
  it('prints the report table and writes one JSONL line per PR', async () => {
    const t = makeDeps(PRS);
    await cmdClassifierBacktest(opts(), t.deps);
    const out = t.logs.join('\n');
    expect(out).toContain('Shadow class vs outcome:');
    expect(out).toContain('Slip bounds (rule of three');
    expect(out).toMatch(/Wrote \/repo\/\.factory\/state\/classifier-backtest-2026-10-05T00-00-00-000Z\.jsonl/);
    const rows = t.jsonl();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ prNumber: 1, modelClass: 'A', outcomeLabel: 'clean', labelSource: 'heuristic' });
    expect(t.commands).toContain('git diff --numstat --no-renames abc0001^1 abc0001');
  });

  it('stops at --max-cost and says so', async () => {
    const t = makeDeps(PRS);
    await cmdClassifierBacktest(opts({ maxCost: '0.5' }), t.deps);
    expect(t.logs).toContain('budget reached: covered 2 of 4 PRs ($0.80 spent)');
    expect(t.jsonl()).toHaveLength(2);
  });

  it('honors --limit and since', async () => {
    const t = makeDeps([...PRS, pr(9, '2026-07-01T00:00:00.000Z')]);
    await cmdClassifierBacktest(opts({ limit: '2' }), t.deps);
    expect(t.jsonl().map((r) => r.prNumber)).toEqual([1, 2]);
  });

  it('applies a hand-label file over the heuristic', async () => {
    const t = makeDeps(PRS);
    t.files.set('/labels.csv', 'pr,class\n2,defect\n');
    await cmdClassifierBacktest(opts({ labels: '/labels.csv' }), t.deps);
    expect(t.jsonl().find((r) => r.prNumber === 2)).toMatchObject({
      outcomeLabel: 'defect',
      labelSource: 'hand',
      slipped: true,
    });
    expect(t.logs.join('\n')).toContain('A: 4 closed, 1 slipped');
  });

  it('reports when nothing matches', async () => {
    const t = makeDeps([pr(9, '2026-07-01T00:00:00.000Z')]);
    await cmdClassifierBacktest(opts(), t.deps);
    expect(t.logs).toEqual(['No merged factory PRs since 2026-08-01.']);
  });

  it('--json prints one parseable object', async () => {
    const t = makeDeps(PRS);
    await cmdClassifierBacktest(opts({ json: true }), t.deps);
    const last = JSON.parse(t.logs[t.logs.length - 1]);
    expect(last).toMatchObject({ covered: 4, candidates: 4, budgetReached: false });
    expect(last.file).toContain('classifier-backtest-');
    expect(last.report.classes.A.closed).toBe(4);
  });

  it.each([
    [{ since: 'yesterday' }, /--since/],
    [{ since: '2026-13-45' }, /--since/],
    [{ limit: '0' }, /--limit/],
    [{ maxCost: '-1' }, /--max-cost/],
    [{ labels: '/bad.csv' }, /--labels .*labels line 2/],
    [{ labels: '/missing.csv' }, /--labels/],
  ])('rejects bad input %j', async (bad, message) => {
    const t = makeDeps(PRS);
    t.files.set('/bad.csv', 'pr,class\n1,maybe\n');
    const err = await cmdClassifierBacktest(opts(bad), t.deps).catch((e) => e);
    expect(err).toBeInstanceOf(ClassifierBacktestInputError);
    expect(err.message).toMatch(/^factory: /);
    expect(err.message).toMatch(message);
    expect(t.run).not.toHaveBeenCalled();
  });

  it('refuses a non-hex merge sha before running git', async () => {
    const t = makeDeps([pr(1, '2026-08-01T00:00:00.000Z', 'abc; rm -rf /')]);
    await cmdClassifierBacktest(opts(), t.deps);
    expect(t.commands).toEqual([]);
    expect(t.jsonl()[0]).toMatchObject({ modelClass: null, reason: expect.stringContaining('merge diff unavailable') });
  });
});
