import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { planPhase } from './plan.js';
import { specWriteDenied } from './plan-spec-guards.js';
import { specWithDesign, StubModelExecutor } from './plan-test-helpers.js';

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
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
  routingRules: {},
};

const routes: RoutesConfig = { version: 1, routes: { plan: { tier: 'boss', description: 'stub' } } };

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function runPlan(issue: number, output: string) {
  const worktree = await mkdtemp(join(tmpdir(), 'plan-guards-test-'));
  tempDirs.add(worktree);
  const specPath = join(worktree, `.factory/state/plans/issue-${issue}.md`);
  await mkdir(dirname(specPath), { recursive: true });
  const stub = new StubModelExecutor({ scripts: { plan: [{ output: output.replaceAll('$SPEC', specPath) }] } });
  const router = new ModelRouter(models, routes, false, stub);
  const octokit: any = {
    rest: { issues: { get: async () => ({ data: { title: 'Add auth', body: 'Add authentication.' } }) } },
  };
  const logs: Array<{ type: string; msg: string }> = [];
  const result = await planPhase({
    issue,
    repo: 'on-par/software-factory',
    worktree,
    specPath,
    router,
    constitution: null,
    octokit,
    log: (type, msg) => {
      logs.push({ type, msg });
    },
  });
  return { result, specPath, logs };
}

describe('planPhase denied spec write (#3269)', () => {
  it('a denied spec write parks config and never saves the denial as the spec (#3103 on 10/19)', async () => {
    const { result, specPath } = await runPlan(
      3103,
      'I could not write $SPEC: sandbox denied writing outside the writable workspace',
    );
    expect(result.ok).toBe(false);
    expect(result.parkReason).toBe('config');
    expect(result.escalate).toContain(specPath);
    expect(existsSync(specPath)).toBe(false);
  });

  it('an ESCALATE line reporting a denied spec write parks config, not escalate (#3201)', async () => {
    const { result, logs } = await runPlan(
      3201,
      'ESCALATE: The sandbox denied writing $SPEC because it is outside the writable workspace',
    );
    expect(result.parkReason).toBe('config');
    expect(logs.some((l) => l.type === 'escalate')).toBe(false);
    expect(logs.some((l) => l.type === 'config')).toBe(true);
  });

  it('still escalates an ESCALATE line with no denial phrase', async () => {
    const { result, logs } = await runPlan(3202, 'ESCALATE: please split this');
    expect(result.ok).toBe(false);
    expect(result.parkReason).toBeUndefined();
    expect(logs.some((l) => l.type === 'escalate')).toBe(true);
  });

  it('saves a chat-only spec that mentions the path without a denial phrase', async () => {
    const { result, specPath } = await runPlan(3203, `${specWithDesign('Chat only')}\nSee $SPEC.\n`);
    expect(result.parkReason).toBeUndefined();
    expect(existsSync(specPath)).toBe(true);
  });
});

describe('specWriteDenied', () => {
  const specPath = '/repo/.factory/state/plans/issue-9.md';

  it.each([
    'sandbox denied',
    'Operation not permitted',
    'EACCES',
    'EPERM',
    'outside the writable roots',
    'Read-only file system',
  ])('is true for "%s" together with the spec path', (phrase) => {
    expect(specWriteDenied(`${phrase} writing ${specPath}`, specPath)).toBe(true);
  });

  it('is true when only plans/<basename> is named', () => {
    expect(specWriteDenied('EPERM: cannot write plans/issue-9.md', specPath)).toBe(true);
  });

  it('is false with a denial phrase but an unrelated path', () => {
    expect(specWriteDenied('sandbox denied writing /other/file.ts', specPath)).toBe(false);
  });

  it('is false with the path but no denial phrase', () => {
    expect(specWriteDenied(`wrote ${specPath}`, specPath)).toBe(false);
  });

  it('is false for a chat-only spec body mentioning the path', () => {
    expect(specWriteDenied(`---\nroute: claude\n---\n# Spec\nSpec lives at ${specPath}`, specPath)).toBe(false);
  });
});
