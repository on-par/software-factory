// packages/cli/src/cli/doctor-json.test.ts — `factory doctor --json` (#3473)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { coreFakes, h, installDoctorHarness, logged, runMainWith } from './test-support/doctor-harness.js';

installDoctorHarness();

describe('doctor --json', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', join(h.repoRoot, 'test-home'));
    h.execSyncImpl = (cmd: string) => (cmd.includes('rev-parse') ? h.repoRoot : '');
  });

  it('doctor --json prints verify rows with command, source and onPath', async () => {
    coreFakes.isCommandAvailable.mockImplementation((c: string) => c === 'bash');
    mkdirSync(join(h.repoRoot, 'scripts'), { recursive: true });
    writeFileSync(join(h.repoRoot, 'scripts', 'verify.sh'), '#!/bin/sh\n');
    await runMainWith(undefined, 'doctor', '--json');
    const out = JSON.parse(logged().slice(logged().indexOf('{'))) as {
      checks: { name: string }[];
      verify: unknown[];
    };
    expect(out.checks.some((c) => c.name === 'verify test')).toBe(true);
    expect(out.verify).toContainEqual({
      kind: 'test',
      command: 'bash scripts/verify.sh --no-e2e',
      source: 'scripts/verify.sh',
      executable: 'bash',
      onPath: true,
    });
  });

  it('doctor --json includes clockSkewMs measured from the GitHub Date header', async () => {
    h.octokit = {
      rest: {
        rateLimit: {
          get: vi.fn().mockResolvedValue({ headers: { date: new Date(Date.now() - 300_000).toUTCString() }, data: {} }),
        },
      },
    };
    await runMainWith(undefined, 'doctor', '--json');
    const out = JSON.parse(logged().slice(logged().indexOf('{'))) as {
      clockSkewMs: number | null;
      checks: { name: string; ok: boolean; optional?: boolean }[];
    };
    expect(Math.abs((out.clockSkewMs ?? 0) - 300_000)).toBeLessThan(5000);
    expect(out.checks.find((c) => c.name === 'clock skew')).toMatchObject({ ok: false, optional: true });
  });

  it('doctor --json has a null clockSkewMs when the response carries no Date header', async () => {
    h.octokit = { rest: { rateLimit: { get: vi.fn().mockResolvedValue({ data: {} }) } } };
    await runMainWith(undefined, 'doctor', '--json');
    const out = JSON.parse(logged().slice(logged().indexOf('{'))) as { clockSkewMs: number | null };
    expect(out).toHaveProperty('clockSkewMs', null);
  });
});
