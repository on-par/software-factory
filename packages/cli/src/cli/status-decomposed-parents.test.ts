// packages/cli/src/cli/status-decomposed-parents.test.ts — merged-child coverage of decomposed parents in status (#3108)

import { computeParentCoverage, renderParentCoverageComment } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { statusJsonSchema } from './json-contract.js';
import { h, installShipHarness, logged, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

const PARENT_BODY = [
  '## Acceptance criteria',
  '- [ ] first',
  '- [ ] second',
  '- [ ] third',
  '- [ ] fourth',
  '- [ ] fifth',
].join('\n');

const child = (number: number, ids: string, state_reason: string | null = 'completed') => ({
  number,
  body: `Decomposed from #10 by the factory size gate.\nCovers parent criteria: ${ids}\n`,
  state: state_reason === null ? 'open' : 'closed',
  state_reason,
});

function stubParent(children: unknown[]): void {
  h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [{ number: 10 }, { number: 11, pull_request: {} }] }));
  h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Parent', body: PARENT_BODY } }));
  h.octokit.request = vi.fn(async () => ({ data: children }));
  h.octokit.rest.pulls.list = vi.fn(async () => ({ data: [] }));
}

describe('cli status decomposed parents (#3108)', () => {
  it('shows 2/5 for a parent with two covered criteria and the coverage comment lists the 3 uncovered ones', async () => {
    stubParent([child(21, 'P1'), child(22, 'P2'), child(23, 'P3', null), child(24, 'P4', 'not_planned')]);
    await runMain('status');
    expect(logged()).toContain('== Decomposed parents ==');
    expect(logged()).toContain('parent #10: 2/5 criteria covered');

    vi.mocked(console.log).mockClear();
    await runMain('status', '--json');
    const json = JSON.parse(logged().trim());
    expect(statusJsonSchema.parse(json)).toEqual(json);
    expect(json.decomposedParents).toHaveLength(1);
    expect(json.decomposedParents[0]).toMatchObject({ issue: 10, covered: 2, total: 5, fullyCovered: false });
    expect(json.decomposedParents[0].uncovered.map((u: { id: string }) => u.id)).toEqual(['P3', 'P4', 'P5']);

    const comment = renderParentCoverageComment(
      computeParentCoverage({ number: 10, body: PARENT_BODY }, [
        { number: 21, body: child(21, 'P1').body, merged: true },
        { number: 22, body: child(22, 'P2').body, merged: true },
      ]),
    );
    for (const id of ['P3', 'P4', 'P5']) expect(comment).toContain(`- ${id}:`);
  });

  it('shows a parent whose every criterion has a merged child as fully covered', async () => {
    stubParent([child(21, 'P1, P2, P3'), child(22, 'P4, P5')]);
    await runMain('status');
    expect(logged()).toContain('5/5 criteria covered (fully covered)');

    vi.mocked(console.log).mockClear();
    await runMain('status', '--json');
    expect(JSON.parse(logged().trim()).decomposedParents[0].fullyCovered).toBe(true);
  });

  it('reports a failed lookup in text and null in JSON', async () => {
    stubParent([]);
    h.octokit.rest.issues.listForRepo = vi.fn(async () => {
      throw new Error('down');
    });
    await runMain('status');
    expect(logged()).toContain('(decomposed parent lookup failed)');
    vi.mocked(console.log).mockClear();
    await runMain('status', '--json');
    expect(JSON.parse(logged().trim()).decomposedParents).toBeNull();
  });

  it('prints (none) when no parent is decomposed', async () => {
    stubParent([]);
    h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));
    await runMain('status');
    expect(logged()).toMatch(/== Decomposed parents ==\n {2}\(none\)/);
  });
});
