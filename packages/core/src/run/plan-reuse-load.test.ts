import { describe, expect, it } from 'vitest';

import { workKeyFromIssue } from '../work/work-key.js';
import { loadReusablePlan } from './plan-reuse-load.js';
import type { PlanResult } from '../phases/plan.js';
import { issueBodyHash, type PlanReuseStore } from './resume-context.js';

const request = { issue: workKeyFromIssue(7), specPath: '/plans/issue-7.md', work: { brief: 'body' } };

function planResult(): PlanResult {
  return { ok: true, route: 'claude', specPath: '/plans/issue-7.md', model: 'm', designArtifact: null };
}

function setup(store: Partial<PlanReuseStore>, hit: PlanResult | null = null) {
  const logs: Array<[string, string]> = [];
  const loaded: string[] = [];
  let clears = 0;
  const full: PlanReuseStore = {
    load: async (hash: string) => (loaded.push(hash), hit),
    record: async () => undefined,
    clear: async () => void (clears += 1),
    ...store,
  };
  const log = (k: string, m: string) => void logs.push([k, m]);
  const planLog = log;
  return { full, log, planLog, logs, loaded, clears: () => clears };
}

describe('loadReusablePlan (#2340)', () => {
  it('returns null without a store', async () => {
    const { log, planLog, logs } = setup({});
    expect(await loadReusablePlan(undefined, request, log, planLog)).toBeNull();
    expect(logs).toEqual([]);
  });

  it('logs plan_reused for #7 on a hit and always clears', async () => {
    const hit = planResult();
    const { full, log, planLog, logs, loaded, clears } = setup({}, hit);
    expect(await loadReusablePlan(full, request, log, planLog)).toBe(hit);
    expect(loaded).toEqual([issueBodyHash('body')]);
    expect(clears()).toBe(1);
    expect(logs).toEqual([
      [
        'plan_reused',
        'reusing frozen plan /plans/issue-7.md for #7 — body unchanged since the environment release, no PLAN model call',
      ],
    ]);
  });

  it('does not log plan_reused on a miss but still clears', async () => {
    const { full, log, planLog, clears } = setup({});
    expect(await loadReusablePlan(full, request, log, planLog)).toBeNull();
    expect(clears()).toBe(1);
  });

  it('warns and plans when load throws, and still clears', async () => {
    const { full, log, planLog, logs, clears } = setup({
      load: async () => {
        throw new Error('boom');
      },
    });
    expect(await loadReusablePlan(full, request, log, planLog)).toBeNull();
    expect(logs).toEqual([['environment_warning', 'could not read the plan-reuse record: boom — planning']]);
    expect(clears()).toBe(1);
  });

  it('warns when clear throws', async () => {
    const { full, log, planLog, logs } = setup({
      clear: async () => {
        throw new Error('nope');
      },
    });
    await loadReusablePlan(full, request, log, planLog);
    expect(logs).toEqual([['environment_warning', 'could not clear the plan-reuse record: nope']]);
  });
});
