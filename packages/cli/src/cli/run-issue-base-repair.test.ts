// `factory run-issue` with the FACTORY_BASE_HEALTH_REPAIR env contract: only the exact value `1` lets a red
// pre-PLAN base enter PLAN; an inconclusive base, any other value, and other commands still release.
// Observed through what the commands receive and through the run's own events file, not mock call counts.
import { existsSync, readFileSync } from 'node:fs';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROGRAM_HANDLERS, type ProgramHandlers } from './index.js';
import { registerRunWorkCommands } from './program-run-work.js';
import type { ShipIssueOptions } from './ship-options.js';
import { h, installShipHarness, paths, phases, shipIssue } from './test-support/ship-harness.js';

installShipHarness();
afterEach(() => vi.unstubAllEnvs());

/** Parses `factory <argv>` through the real Run work registrar; returns the options each handler received. */
async function parsedOptions(argv: string[]): Promise<Record<string, object>> {
  const received: Record<string, object> = {};
  const handlers: ProgramHandlers = {
    ...PROGRAM_HANDLERS,
    cmdRunIssue: async (_issue, opts) => {
      received['run-issue'] = opts;
    },
    cmdShip: async (_issue, opts) => {
      received.ship = opts;
    },
  };
  const program = new Command().exitOverride();
  registerRunWorkCommands(program, handlers);
  await program.parseAsync(['node', 'factory', ...argv]);
  return received;
}

describe('run-issue reads FACTORY_BASE_HEALTH_REPAIR', () => {
  it('passes baseHealthRepair: true to run-issue for the exact value 1', async () => {
    vi.stubEnv('FACTORY_BASE_HEALTH_REPAIR', '1');
    expect((await parsedOptions(['run-issue', '5']))['run-issue']).toMatchObject({ baseHealthRepair: true });
  });

  it.each([undefined, '', '0', 'false', 'true', 'yes', ' 1', '1 '])(
    'passes baseHealthRepair: false for %j',
    async (value) => {
      if (value !== undefined) vi.stubEnv('FACTORY_BASE_HEALTH_REPAIR', value);
      expect((await parsedOptions(['run-issue', '5']))['run-issue']).toMatchObject({ baseHealthRepair: false });
    },
  );

  it('is a run-issue contract: ship never receives it', async () => {
    vi.stubEnv('FACTORY_BASE_HEALTH_REPAIR', '1');
    expect((await parsedOptions(['ship', '5'])).ship).not.toHaveProperty('baseHealthRepair');
  });
});

const BASE = 'c'.repeat(40);
type Health = Awaited<ReturnType<NonNullable<typeof phases.checkBaseHealth>>>;
const RED: Health = {
  kind: 'red',
  baseSha: BASE,
  failingChecks: ['tests'],
  cached: false,
  // No vitest FAIL-marker text here: this run's log lines reach the verify output, which must stay marker-free when green.
  evidence: [
    { checker: 'tests', command: 'bash scripts/verify.sh --no-e2e', exitCode: 1, tail: 'AssertionError: 3 != 4' },
  ],
};
const INCONCLUSIVE: Health = {
  kind: 'inconclusive',
  baseSha: BASE,
  failingChecks: [],
  cached: false,
  evidence: [{ checker: 'tests', cause: 'timeout', timeoutSeconds: 600, tail: 'timed out' }],
};

/** shipIssue against a base health verdict; returns the event types and lines the run recorded. */
async function shipAgainst(health: Health, opts: ShipIssueOptions) {
  phases.checkBaseHealth.mockImplementation(async () => health);
  await shipIssue(5, opts, { repoRoot: h.repoRoot, ghRepo: h.ghRepo }).catch(() => undefined);
  const lines = existsSync(paths().events) ? readFileSync(paths().events, 'utf-8').split('\n').filter(Boolean) : [];
  const events = lines.map((l) => ({ type: (JSON.parse(l) as { type: string }).type, line: l }));
  return {
    types: events.map((e) => e.type),
    lines: (type: string) => events.filter((e) => e.type === type).map((e) => e.line),
  };
}

describe('shipIssue with baseHealthRepair', () => {
  it('a red base records base_repair_proceeding with the failing checks and runs on through PLAN to a PR', async () => {
    const run = await shipAgainst(RED, { baseHealthRepair: true });

    const [proceeding, ...more] = run.lines('base_repair_proceeding');
    expect(more).toEqual([]);
    expect(proceeding).toContain(`origin/main ${BASE.slice(0, 8)} fails tests before PLAN`);
    expect(proceeding).toContain('FACTORY_BASE_HEALTH_REPAIR=1');
    expect(run.types).not.toContain('environment-released');
    expect(run.lines('ready').join('\n')).toContain('PR #99 ready for review');
  });

  it('an inconclusive base still releases before PLAN', async () => {
    const run = await shipAgainst(INCONCLUSIVE, { baseHealthRepair: true });

    expect(run.lines('environment-released').join('\n')).toContain('could not run');
    expect(run.types).not.toContain('base_repair_proceeding');
    expect(run.types).not.toContain('ready');
  });

  it.each([
    ['absent', {}],
    ['false', { baseHealthRepair: false }],
  ] as const)('a red base with baseHealthRepair %s releases before PLAN, unchanged', async (_label, opts) => {
    const run = await shipAgainst(RED, opts);

    expect(run.lines('environment-released').join('\n')).toContain('fails tests before PLAN');
    expect(run.types).not.toContain('base_repair_proceeding');
    expect(run.types).not.toContain('ready');
  });
});
