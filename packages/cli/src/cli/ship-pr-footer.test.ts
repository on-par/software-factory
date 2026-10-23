import { describe, expect, it } from 'vitest';
import { h, installShipHarness, phases, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

describe('pr.footer config reaches SHIP', () => {
  it.each(['ship', 'run-issue'])('%s leaves an unset footer at the default', async (command) => {
    await runMainWith(undefined, command, '5');
    expect(phases.shipPhase.mock.calls.at(-1)?.[0].footer).toBeUndefined();
  });

  it.each(['Custom {{repo}} footer', ''])('passes footer %j verbatim', async (footer) => {
    h.factoryConfig = { ...h.factoryConfig, pr: { footer } };
    await runMainWith(undefined, 'ship', '5');
    expect(phases.shipPhase.mock.calls.at(-1)?.[0].footer).toBe(footer);
  });
});
