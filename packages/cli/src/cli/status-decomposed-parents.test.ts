// packages/cli/src/cli/status-decomposed-parents.test.ts — status no longer reports decomposed parents; decomposedParents is deprecated and empty (#3834)

import { describe, expect, it, vi } from 'vitest';

import { statusJsonSchema } from './json-contract.js';
import { h, installShipHarness, logged, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

function stubParent(): void {
  h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
    data: [{ number: 10, labels: [{ name: 'factory:decomposed' }] }],
  }));
  h.octokit.rest.pulls.list = vi.fn(async () => ({ data: [] }));
}

describe('cli status decomposed parents (#3834)', () => {
  it('status --json emits an empty decomposedParents array with open decomposed parents', async () => {
    stubParent();
    await runMain('status', '--json');
    const json = JSON.parse(logged().trim());
    expect(statusJsonSchema.parse(json)).toEqual(json);
    expect(json.schemaVersion).toBe(1);
    expect(json.decomposedParents).toEqual([]);
  });

  it('human status prints no Decomposed parents section', async () => {
    stubParent();
    await runMain('status');
    expect(logged()).not.toContain('Decomposed parents');
  });

  it('status --json emits an empty decomposedParents array when the issue lookup fails', async () => {
    stubParent();
    h.octokit.rest.issues.listForRepo = vi.fn(async () => {
      throw new Error('down');
    });
    await runMain('status', '--json');
    expect(JSON.parse(logged().trim()).decomposedParents).toEqual([]);
  });
});
