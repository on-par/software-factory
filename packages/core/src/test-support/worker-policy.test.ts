import { describe, expect, it } from 'vitest';

import { WORKER_MODELS, WORKER_ROUTES, workerPolicy } from './worker-policy.js';

describe('worker policy fixture', () => {
  it('routes every build route to a tier the models config defines', () => {
    const tiers = Object.keys(WORKER_MODELS.tiers);
    for (const route of Object.values(WORKER_ROUTES.routes)) expect(tiers).toContain(route.tier);
    expect(workerPolicy.models).toBe(WORKER_MODELS);
    expect(workerPolicy.routes).toBe(WORKER_ROUTES);
  });
});
