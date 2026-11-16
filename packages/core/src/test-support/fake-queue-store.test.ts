import { describe, expect, it } from 'vitest';

import { createFakeStore } from './fake-queue-store.js';

const OWNER_REPO = { owner: 'o', repo: 'r' };

describe('createFakeStore', () => {
  it('lists only issues carrying every requested label', async () => {
    const { client } = createFakeStore([
      { number: 1, labels: ['a', 'b'] },
      { number: 2, labels: ['a'] },
      { number: 3, labels: ['b', 'a', 'c'] },
    ]);
    const issues = await client.listOpenIssuesWithLabels({ ...OWNER_REPO, labels: ['a', 'b'] });
    expect(issues.map((i) => i.number)).toEqual([1, 3]);
  });

  it('records label writes in order', async () => {
    const { client, writes, state } = createFakeStore([{ number: 7, labels: ['x'] }]);
    await client.addLabels({ ...OWNER_REPO, issue_number: 7, labels: ['y'] });
    await client.removeLabel({ ...OWNER_REPO, issue_number: 7, name: 'x' });
    expect(writes).toEqual(['add #7', 'remove #7:x']);
    expect([...(state.get(7) ?? [])]).toEqual(['y']);
  });

  it('records every client call by name', async () => {
    const { client, calls } = createFakeStore([{ number: 1, labels: [] }]);
    await client.listOpenIssuesWithLabels({ ...OWNER_REPO, labels: [] });
    await client.getIssueLabels({ ...OWNER_REPO, issue_number: 1 });
    await client.addLabels({ ...OWNER_REPO, issue_number: 1, labels: ['a'] });
    await client.removeLabel({ ...OWNER_REPO, issue_number: 1, name: 'a' });
    await client.ensureLabel({ ...OWNER_REPO, name: 'a', color: 'ffffff', description: '' });
    expect(calls).toEqual(['listOpenIssuesWithLabels', 'getIssueLabels', 'addLabels', 'removeLabel', 'ensureLabel']);
  });

  it('ensureLabel records the label and reports it as not created', async () => {
    const { client, createdLabels } = createFakeStore([]);
    const created = await client.ensureLabel({ ...OWNER_REPO, name: 'factory:x', color: 'ffffff', description: '' });
    expect(created).toBe(false);
    expect([...createdLabels]).toEqual(['factory:x']);
  });

  it('exposes repo-label methods only when repoLabels is passed', () => {
    const without = createFakeStore([]).client;
    expect(without.listRepoLabels).toBeUndefined();
    expect(without.deleteRepoLabel).toBeUndefined();
    expect(without.listAllOpenIssues).toBeUndefined();
    const withLabels = createFakeStore([], []).client;
    expect(withLabels.listRepoLabels).toBeTypeOf('function');
    expect(withLabels.deleteRepoLabel).toBeTypeOf('function');
    expect(withLabels.listAllOpenIssues).toBeTypeOf('function');
  });

  it('deleteRepoLabel records the name and removes it from repoLabelSet', async () => {
    const { client, deletedRepoLabels, repoLabelSet } = createFakeStore([{ number: 4, labels: ['k'] }], ['a', 'b']);
    await client.deleteRepoLabel?.({ ...OWNER_REPO, name: 'a' });
    expect(deletedRepoLabels).toEqual(['a']);
    expect([...repoLabelSet]).toEqual(['b']);
    expect(await client.listRepoLabels?.(OWNER_REPO)).toEqual(['b']);
    expect(await client.listAllOpenIssues?.(OWNER_REPO)).toEqual([{ number: 4, labels: ['k'] }]);
  });
});
