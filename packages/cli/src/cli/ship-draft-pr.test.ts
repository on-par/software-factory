import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readRunFlagOverrides } from './run-flags.js';
import { h, installShipHarness, paths, phases, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);
const shipOpts = () => phases.shipPhase.mock.calls.at(-1)?.[0] as any;

describe('draft PR (#3449)', () => {
  it.each(['run-issue', 'ship'])('%s 5 --draft-pr passes draft true to SHIP and records the flag', async (cmd) => {
    const res = await runMain(cmd, '5', '--draft-pr');
    expect(res.exited).toBe(false);
    expect(shipOpts().draft).toBe(true);
    expect(readRunFlagOverrides(paths().runFlags).draftPr).toBe(true);
  });

  it('run-brief --draft-pr passes draft true to SHIP', async () => {
    const brief = join(h.repoRoot, 'brief.md');
    writeFileSync(brief, '# Add a widget\n\nPlease add a widget.\n\n## Acceptance criteria\n\n- the widget exists\n');
    await runMain('run-brief', brief, '--draft-pr');
    expect(shipOpts().draft).toBe(true);
  });

  it('no flag and no config key passes draft false to SHIP', async () => {
    await runMain('ship', '5');
    expect(shipOpts().draft).toBeFalsy();
    expect(readRunFlagOverrides(paths().runFlags).draftPr).toBeUndefined();
  });

  it('run.pr.draft true ships a draft and --no-draft-pr overrides it', async () => {
    h.factoryConfig = { ...h.factoryConfig, run: { pr: { draft: true } } };
    await runMain('ship', '5');
    expect(shipOpts().draft).toBe(true);
    await runMain('ship', '5', '--no-draft-pr');
    expect(shipOpts().draft).toBeFalsy();
    expect(readRunFlagOverrides(paths().runFlags).draftPr).toBe(false);
  });
});
