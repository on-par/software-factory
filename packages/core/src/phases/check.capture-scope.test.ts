import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type CommandOutputRecord, registerCommandOutputSink } from '../command-output/capture.js';
import { runVerificationCommand } from '../checkers/run-command.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { checkPhase } from './check.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'] },
  failover: { triggers: ['rate_limit', 'unavailable', 'auth'], maxRetries: 2, cooldownMs: 0 },
  routingRules: {},
};
const routes: RoutesConfig = { version: 1, routes: { build_claude: { tier: 'boss', description: 'stub' } } };

const tmp = createTempDirs();
const unregs: Array<() => void> = [];
afterEach(async () => {
  while (unregs.pop()?.());
  await tmp.cleanup();
});

async function run(extra: { runId?: string; laneId?: string }): Promise<CommandOutputRecord[]> {
  const records: CommandOutputRecord[] = [];
  unregs.push(registerCommandOutputSink((r) => records.push(r)));
  const worktree = await tmp.make('check-capture-');
  await writeFile(join(worktree, 'issue-3994.md'), '# Spec\n');
  await checkPhase({
    issue: workKeyFromIssue(3994),
    worktree,
    specPath: join(worktree, 'issue-3994.md'),
    router: new ModelRouter(models, routes, false, new StubModelExecutor({ defaultOutput: 'ok' })),
    constitution: null,
    log: () => {},
    autoRework: false,
    ...extra,
    runCheckers: async () => {
      await runVerificationCommand([process.execPath, '-e', `console.log('hello')`], {});
      return { failures: 0, passes: 1, skips: 0, total: 1, results: [{ checker: 'x', result: 'PASS', details: 'ok' }] };
    },
  });
  return records;
}

describe('checkPhase capture scope (#3994)', () => {
  it('checkPhase opens a capture scope stamped with runId, issue, lane and phase check', async () => {
    const records = await run({ runId: 'run-9', laneId: 'lane-9' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      runId: 'run-9',
      issue: String(workKeyFromIssue(3994)),
      lane: 'lane-9',
      phase: 'check',
      text: 'hello\n',
    });
  });

  it('checkPhase without runId opens no scope', async () => {
    expect(await run({})).toEqual([]);
  });
});
