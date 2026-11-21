import { describe, expect, it } from 'vitest';

import { defaultModelsConfig, defaultRoutesConfig } from './defaults.js';
import { copilotModels } from './defaults-copilot.js';

describe('copilot-default', () => {
  const model = defaultModelsConfig.models['copilot-default'];

  it('ships through the copilot-cli harness with no provider model, so no --model is sent', () => {
    expect(copilotModels['copilot-default']).toBe(model);
    expect(model).toMatchObject({ provider: 'copilot', harness: 'copilot-cli', envKey: null, experimental: true });
    expect(model?.providerModel).toBeUndefined();
  });

  it('carries a zero registry price', () => {
    expect([model?.costPerMtokInput, model?.costPerMtokOutput]).toEqual([0, 0]);
  });

  it('is pin-only: in no default tier and no provider order', () => {
    expect(model?.tier).toEqual([]);
    for (const ids of Object.values(defaultModelsConfig.tiers)) expect(ids).not.toContain('copilot-default');
    for (const ids of Object.values(defaultModelsConfig.providerOrder)) expect(ids).not.toContain('copilot-default');
  });

  it('has a build_copilot route on the worker tier that requires the copilot harness', () => {
    expect(defaultRoutesConfig.routes.build_copilot).toMatchObject({ tier: 'worker', requires: 'copilot' });
  });
});
