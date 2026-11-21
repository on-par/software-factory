import { describe, expect, it } from 'vitest';

import { loadModelsConfig, type RoutesConfig } from '../config/index.js';
import type { CodingHarness, HarnessRequest } from '../harness/index.js';
import { recordArgs } from '../test-support/recorders.js';
import { CliModelExecutor, ModelRouter } from './index.js';

const routes: RoutesConfig = { version: 1, routes: { triage: { tier: 'copilot_only', description: 'stub' } } };

async function copilotRequestAfter(configure: (router: ModelRouter) => void): Promise<HarnessRequest | undefined> {
  const base = loadModelsConfig();
  const { calls, fn: run } = recordArgs(async (_req: HarnessRequest) => ({ output: 'ok' }));
  const copilot: CodingHarness = { id: 'copilot-cli', agentic: true, run };
  const router = new ModelRouter(
    { ...base, tiers: { copilot_only: ['copilot-default'] } },
    routes,
    false,
    new CliModelExecutor(undefined, undefined, { 'copilot-cli': copilot }),
    true,
  );
  configure(router);
  await router.run('triage', 'sort these');
  return calls[0]?.[0];
}

describe('ModelRouter sandbox.copilotAllowAll threading', () => {
  it('forwards copilotAllowAll: true onto the Copilot HarnessRequest', async () => {
    const req = await copilotRequestAfter((router) => router.setCopilotAllowAll(true));
    expect(req).toMatchObject({ model: 'copilot-default', copilotAllowAll: true });
  });

  it.each([
    ['never set', () => {}],
    ['set to undefined', (router: ModelRouter) => router.setCopilotAllowAll(undefined)],
    ['reset to false', (router: ModelRouter) => [true, false].forEach((v) => router.setCopilotAllowAll(v))],
  ])('sends copilotAllowAll: false when %s', async (_label, configure) => {
    expect((await copilotRequestAfter(configure))?.copilotAllowAll).toBe(false);
  });
});
