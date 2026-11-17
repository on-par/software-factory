import { describe, expect, it } from 'vitest';

import { coreFakes, h, installShipHarness, logged, shipIssue } from './test-support/ship-harness.js';

installShipHarness();

describe('shipIssue agent events (#4246)', () => {
  it('prints each agent event as one [factory] agent-event stdout line', async () => {
    const event = { phase: 'build', kind: 'text', summary: 'hi', at: '2026-01-01T00:00:00Z' };
    const { ModelRouter } = coreFakes;
    function RouterWithEvents(...args: ConstructorParameters<typeof ModelRouter>) {
      return { ...new ModelRouter(...args), setAgentEventSink: (sink: (e: typeof event) => void) => sink(event) };
    }
    await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo }, { ModelRouter: RouterWithEvents as never });
    expect(logged()).toContain(`[factory] agent-event ${JSON.stringify(event)}`);
  });
});
