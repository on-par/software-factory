import { describe, expect, it } from 'vitest';

import { simModelsConfig, simRoutesConfig } from '../sim/pipeline.js';
import type { RunPolicy } from './policy.js';

describe('RunPolicy', () => {
  it('is a plain resolved value assembled from resolved config parts', () => {
    const policy: RunPolicy = {
      models: simModelsConfig(),
      routes: simRoutesConfig(),
      sandbox: { enabled: false, network: { allow: [] }, resources: { cpuMs: 1, memMb: 1 } },
      budget: { perIssueCapUsd: 5 },
      effective: { localOnly: false, allowExperimental: false, codexDisabled: false, branchPrefix: 'ship-it' },
    };
    expect(policy.models.version).toBe(1);
    expect(policy.routes.version).toBe(1);
    expect(policy.budget.perIssueCapUsd).toBe(5);
    expect(policy.effective.branchPrefix).toBe('ship-it');
  });

  it('allows an uncapped budget', () => {
    const budget: RunPolicy['budget'] = {};
    expect(budget.perIssueCapUsd).toBeUndefined();
  });
});
