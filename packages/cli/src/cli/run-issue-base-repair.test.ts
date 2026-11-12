// `factory run-issue` with the retired FACTORY_BASE_HEALTH_REPAIR env flag (#4029): still starts, warns it is
// deprecated; every run reaches PLAN with no pre-PLAN base health check. Observed through the handler call,
// stderr and the run's own events file, not mock call counts of removed ports.
import { existsSync, readFileSync } from 'node:fs';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROGRAM_HANDLERS, type ProgramHandlers } from './index.js';
import { registerRunWorkCommands } from './program-run-work.js';
import { h, installShipHarness, paths, phases, shipIssue } from './test-support/ship-harness.js';

installShipHarness();
afterEach(() => vi.unstubAllEnvs());

/** Parses `factory run-issue 5` through the real Run work registrar; returns the issue numbers the handler received. */
async function runIssueCalls(): Promise<number[]> {
  const received: number[] = [];
  const handlers: ProgramHandlers = {
    ...PROGRAM_HANDLERS,
    cmdRunIssue: async (issue) => {
      received.push(issue);
    },
  };
  const program = new Command().exitOverride();
  registerRunWorkCommands(program, handlers);
  await program.parseAsync(['node', 'factory', 'run-issue', '5']);
  return received;
}

describe('run-issue and FACTORY_BASE_HEALTH_REPAIR (#4029)', () => {
  it('run-issue with FACTORY_BASE_HEALTH_REPAIR=1 still starts and warns that the flag is deprecated', async () => {
    vi.stubEnv('FACTORY_BASE_HEALTH_REPAIR', '1');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await runIssueCalls()).toEqual([5]);
      const written = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('warning: FACTORY_BASE_HEALTH_REPAIR=1 is deprecated');
    } finally {
      stderr.mockRestore();
    }
  });

  it('run-issue without the flag starts silently', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await runIssueCalls()).toEqual([5]);
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).not.toContain('FACTORY_BASE_HEALTH_REPAIR');
    } finally {
      stderr.mockRestore();
    }
  });

  it('shipIssue reaches PLAN without the repair flag and runs no base health check', async () => {
    await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo }).catch(() => undefined);
    const lines = existsSync(paths().events) ? readFileSync(paths().events, 'utf-8').split('\n').filter(Boolean) : [];
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(phases.planPhase).toHaveBeenCalled();
    expect(types).not.toContain('environment-released');
    expect(types).not.toContain('base_repair_proceeding');
  });
});
