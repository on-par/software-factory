import { describe, expect, it, vi } from 'vitest';

import { workKeyFromIssue } from '../work/work-key.js';
import { loadReusablePlan } from './plan-reuse-load.js';
import type { PlanResult } from '../phases/plan.js';
import { issueBodyHash, type PlanReuseStore } from './resume-context.js';

const request = { issue: workKeyFromIssue(7), specPath: '/plans/issue-7.md', work: { brief: 'body' } };

function planResult(): PlanResult {
  return { ok: true, route: 'claude', specPath: '/plans/issue-7.md', model: 'm', designArtifact: null };
}

function setup(store: Partial<PlanReuseStore>) {
  const log = vi.fn();
  const planLog = vi.fn();
  const full: PlanReuseStore = {
    load: vi.fn(async () => null),
    record: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    ...store,
  };
  return { full, log, planLog };
}

describe('loadReusablePlan (#2340)', () => {
  it('returns null without a store', async () => {
    const { log, planLog } = setup({});
    expect(await loadReusablePlan(undefined, request, log, planLog)).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('logs plan_reused for #7 on a hit and always clears', async () => {
    const hit = planResult();
    const { full, log, planLog } = setup({ load: vi.fn(async () => hit) });
    expect(await loadReusablePlan(full, request, log, planLog)).toBe(hit);
    expect(full.load).toHaveBeenCalledWith(issueBodyHash('body'));
    expect(full.clear).toHaveBeenCalledTimes(1);
    expect(planLog).toHaveBeenCalledWith(
      'plan_reused',
      'reusing frozen plan /plans/issue-7.md for #7 — body unchanged since the environment release, no PLAN model call',
    );
  });

  it('does not log plan_reused on a miss but still clears', async () => {
    const { full, log, planLog } = setup({});
    expect(await loadReusablePlan(full, request, log, planLog)).toBeNull();
    expect(full.clear).toHaveBeenCalledTimes(1);
    expect(planLog).not.toHaveBeenCalled();
  });

  it('warns and plans when load throws, and still clears', async () => {
    const { full, log, planLog } = setup({
      load: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    expect(await loadReusablePlan(full, request, log, planLog)).toBeNull();
    expect(log).toHaveBeenCalledWith('environment_warning', 'could not read the plan-reuse record: boom — planning');
    expect(full.clear).toHaveBeenCalledTimes(1);
  });

  it('warns when clear throws', async () => {
    const { full, log, planLog } = setup({
      clear: vi.fn(async () => {
        throw new Error('nope');
      }),
    });
    await loadReusablePlan(full, request, log, planLog);
    expect(log).toHaveBeenCalledWith('environment_warning', 'could not clear the plan-reuse record: nope');
  });
});
