// packages/cli/src/cli/run-load-guard.test.ts — factory run wires the host load guard into remote lanes (#3048)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { h, installShipHarness, paths, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const queuedIssue = {
  number: 7,
  title: 'Queued work',
  state: 'open',
  labels: [{ name: 'factory:queued' }, { name: 'factory:lane:app' }],
};

async function eventsContaining(text: string): Promise<string> {
  for (let i = 0; i < 300; i++) {
    const events = existsSync(paths().events) ? readFileSync(paths().events, 'utf-8') : '';
    if (events.includes(text)) return events;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for "${text}" in events`);
}

describe('factory run host load guard (#3048)', () => {
  it('holds a remote lane off claiming while host load is above the configured maxLoad, until STOP', async () => {
    // Any busy host (this test run included) has a 5-minute load average above the smallest positive maxLoad.
    h.factoryConfig = {
      ...h.factoryConfig,
      host: { ...h.factoryConfig.host, loadGuard: { enabled: true, maxLoad: Number.MIN_VALUE, retrySeconds: 1 } },
    };
    h.octokit.rest.issues.listForRepo.mockImplementation(async () => ({ data: [queuedIssue] }) as never);

    const run = runMainWith(undefined, 'run');
    const events = await eventsContaining('not claiming: host load');
    writeFileSync(paths().stop, '');
    const res = await run;

    expect(res.exited).toBe(false);
    expect(events).toMatch(/lane 'app' not claiming: host load \d+\.\d{2} \(5-min avg\) above threshold 5e-324/);
    expect(readFileSync(paths().events, 'utf-8')).toContain('lane complete (0 merged');
  });
});

describe('factory run remote queue', () => {
  it('claims past a disabled load guard and reports queued issues that share an order label', async () => {
    h.factoryConfig = {
      ...h.factoryConfig,
      host: { ...h.factoryConfig.host, loadGuard: { enabled: false, retrySeconds: 1 } },
    };
    const ordered = (number: number) => ({
      ...queuedIssue,
      number,
      labels: [...queuedIssue.labels, { name: 'factory:order:1' }],
    });
    h.octokit.rest.issues.listForRepo.mockImplementation(async () => ({ data: [ordered(7), ordered(8)] }) as never);

    const res = await runMainWith(undefined, 'run');

    expect(res.exited).toBe(false);
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).not.toContain('not claiming: host load');
    expect(events).toContain('lane app: issues #7, #8 share factory:order:1 — claimed in issue-number order');
  });
});
