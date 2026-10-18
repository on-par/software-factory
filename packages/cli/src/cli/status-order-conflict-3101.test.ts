// packages/cli/src/cli/status-order-conflict-3101.test.ts — factory status Queue band reports duplicate factory:order positions (#3101)

import { describe, expect, it, vi } from 'vitest';

import { h, installShipHarness, logged, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

describe('cli status: duplicate factory:order positions', () => {
  it('warns about a duplicate factory:order position in the Queue band and lists both issues (#3101)', async () => {
    const issues = [
      { number: 4, labels: ['factory:queued', 'factory:lane:dup', 'factory:order:1'] },
      { number: 3, labels: ['factory:queued', 'factory:lane:dup', 'factory:order:1'] },
      { number: 5, labels: ['factory:queued', 'factory:lane:dup', 'factory:order:2'] },
    ];
    h.octokit.rest.issues.listForRepo = vi.fn(async ({ labels }: any) => {
      if (labels === 'factory:queued') return { data: issues };
      if (labels === 'factory:queued,factory:lane:dup') return { data: issues };
      return { data: [] };
    });

    await runMainWith(undefined, 'status');
    const out = logged();
    const queueBand = out.slice(out.indexOf('== Queue =='), out.indexOf('== Health =='));
    expect(queueBand.indexOf('dup #3')).toBeGreaterThan(-1);
    expect(queueBand.indexOf('dup #3')).toBeLessThan(queueBand.indexOf('dup #4'));
    expect(queueBand.indexOf('dup #4')).toBeLessThan(queueBand.indexOf('dup #5'));
    const warning = queueBand.split('\n').find((line) => line.includes('lane dup'));
    expect(warning).toContain('#3, #4');
    expect(warning).toContain('factory:order:1');
  });

  it('lists the valid issue and warns once about an issue with no order label (#3192)', async () => {
    const issues = [
      { number: 2253, labels: ['factory:queued', 'factory:lane:self-repair', 'factory:order:1'] },
      { number: 2319, labels: ['factory:queued', 'factory:parked', 'factory:lane:self-repair'] },
    ];
    h.octokit.rest.issues.listForRepo = vi.fn(async ({ labels }: any) => {
      if (labels === 'factory:queued') return { data: issues };
      if (labels === 'factory:queued,factory:lane:self-repair') return { data: issues };
      return { data: [] };
    });

    await runMainWith(undefined, 'status');
    const out = logged();
    const queueBand = out.slice(out.indexOf('== Queue =='), out.indexOf('== Health =='));
    expect(queueBand).toContain('self-repair #2253');
    expect(queueBand).not.toContain('queue lookup failed');
    const lines = queueBand.split('\n').filter((line) => line.includes('#2319'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('lane self-repair');
  });
});
