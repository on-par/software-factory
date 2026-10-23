// packages/cli/src/cli/status-open-factory-drafts.test.ts — open factory drafts in status and kpis (#3553)

import { describe, expect, it, vi } from 'vitest';

import { kpisJsonSchema, statusJsonSchema } from './json-contract.js';
import { h, installShipHarness, logged, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('cli status open factory drafts (#3553)', () => {
  const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000 - 5 * 60_000).toISOString();
  const pr = (ref: string, draft: boolean, hours: number) => ({
    head: { ref },
    draft,
    created_at: hoursAgo(hours),
  });
  const stubPrs = (): void => {
    h.octokit.rest.pulls.list = vi.fn(async () => ({
      data: [
        pr('factory/1-a', true, 30),
        pr('factory/2-b', true, 10),
        pr('factory/3-c', true, 2),
        pr('factory/4-d', false, 50),
        pr('feature/x', true, 50),
      ],
    })) as never;
  };
  const stubFailure = (): void => {
    h.octokit.rest.pulls.list = vi.fn(async () => {
      throw new Error('API down');
    }) as never;
  };
  const healthBand = (): string => {
    const out = logged();
    return out.slice(out.indexOf('== Health =='));
  };
  const stubExec = (): void => {
    h.execImpl = (cmd: string) => {
      if (cmd.includes('rev-parse')) return h.repoRoot;
      if (cmd.includes('gh repo view')) return h.ghRepo;
      return '';
    };
  };

  it('shows the draft count and oldest age in the Health band', async () => {
    stubPrs();
    await runMain('status');
    expect(healthBand()).toContain('Open factory drafts: 3 (oldest 30h)');
  });

  it('status --json and kpis --json carry openFactoryDrafts { count: 3, oldestHours: 30 }', async () => {
    stubPrs();
    await runMain('status', '--json');
    const status = JSON.parse(logged().trim());
    expect(status.openFactoryDrafts).toEqual({ count: 3, oldestHours: 30 });
    expect(statusJsonSchema.parse(status)).toEqual(status);

    vi.mocked(console.log).mockClear();
    stubExec();
    await runMain('kpis', '--json');
    const kpis = JSON.parse(logged().trim());
    expect(kpis.schemaVersion).toBe(1);
    expect(typeof kpis.kpis).toBe('object');
    expect(kpis.openFactoryDrafts).toEqual({ count: 3, oldestHours: 30 });
    expect(kpisJsonSchema.parse(kpis)).toEqual(kpis);
  });

  it('a failing PR listing yields openFactoryDrafts null in status --json', async () => {
    stubFailure();
    await runMain('status', '--json');
    const json = JSON.parse(logged().trim());
    expect(json.openFactoryDrafts).toBeNull();
    expect(json.openFactoryDrafts).not.toEqual({ count: 0, oldestHours: null });
  });

  it('a failing PR listing shows unavailable in the Health band', async () => {
    stubFailure();
    await runMain('status');
    expect(healthBand()).toContain('Open factory drafts: unavailable');
  });
});
