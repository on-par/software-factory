import { workKeyFromIssue } from '../work/work-key.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { execGit } from '../utils/git-exec.js';
import { checkPhase } from './check.js';
import type { CheckSummary } from '../types/index.js';

const tempDirs = createTempDirs();
afterEach(async () => tempDirs.cleanup());

const passingCheckers: CheckSummary = {
  failures: 0,
  passes: 1,
  skips: 0,
  total: 1,
  results: [{ checker: 'compile', result: 'PASS', details: 'ok' }],
};

const models: ModelsConfig = {
  version: 1,
  models: {
    stub: {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub'] },
  failover: { triggers: ['error'], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
};
const routes: RoutesConfig = { version: 1, routes: { build_claude: { tier: 'boss', description: 'test' } } };

describe('checkPhase side effects', () => {
  it('side_effects porcelain paths reach rework and replace stale round output', async () => {
    const worktree = await tempDirs.make('check-side-effects-');
    await execGit(['init', '-q'], { cwd: worktree });
    const specPath = join(worktree, 'issue.md');
    const artifact = {
      restatedProblem: 'Proof is needed.',
      approach: { chosen: 'Run it.', rejected: [] },
      interfacesTouched: [],
      targetTypes: [],
      signatures: [],
      callGraph: [],
      behaviorContract: ['Run after ordinary checks.'],
      verificationPlan: [{ command: 'npm test', passWhen: 'passes' }],
      riskBlastRadius: 'CHECK',
      openQuestions: [],
      evidencePlan: [{ kind: 'command', claim: 'proof', command: 'test', passWhen: 'passes' }],
    };
    await writeFile(join(worktree, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
    await writeFile(specPath, `---\ndesign: ${JSON.stringify(artifact)}\n---\nSpec\n`);
    const executor = new StubModelExecutor({ defaultOutput: 'repaired' });
    const router = new ModelRouter(models, routes, false, executor);
    let evidenceCalls = 0;
    const baseline = vi.fn();
    const check = await checkPhase({
      issue: workKeyFromIssue(3259),
      worktree,
      specPath,
      router,
      constitution: null,
      diffBase: 'abc123',
      log: () => {},
      runCheckers: async () => passingCheckers,
      runBaseline: baseline as never,
      runEvidence: async (entries, _allowlist, _ctx, lifecycle) => {
        evidenceCalls++;
        await lifecycle?.beforeCommand();
        if (evidenceCalls === 1) await writeFile(join(worktree, 'leak.tmp'), 'leaked');
        await lifecycle?.afterCommand(entries![0]!.kind === 'command' ? entries![0]!.command : 'test', []);
        const entry = entries![0]!;
        return [{ claim: entry.claim, kind: entry.kind, status: 'PASS', reason: 'proof passed' }];
      },
    });
    expect(check.passed).toBe(true);
    expect(evidenceCalls).toBe(2);
    expect(check.summary.failures).toBe(0);
    expect(executor.calls[0]?.prompt).toContain(JSON.stringify('leak.tmp'));
    expect(check.summary.results.find((result) => result.checker === 'side_effects')).toMatchObject({ result: 'PASS' });
    expect(baseline).not.toHaveBeenCalled();
  });
});
