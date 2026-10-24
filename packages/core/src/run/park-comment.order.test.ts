import { describe, expect, it, vi } from 'vitest';

import {
  publishParkComment,
  readParkedOrder,
  renderParkComment,
  readParkState,
  upsertParkComment,
} from './park-comment.js';
import { type FakeOctokit, fakeOctokit, input, K7, ME } from './park-comment.test-helpers.js';

describe('park-time order (#3554)', () => {
  const withLabels = (f: FakeOctokit, names: string[] | Error) => {
    const listLabelsOnIssue = vi.fn(async () => {
      if (names instanceof Error) throw names;
      return { data: names.map((name) => ({ name })) };
    });
    Object.assign(f.octokit.rest.issues, { listLabelsOnIssue });
    return listLabelsOnIssue;
  };
  const { parkSha: _omit, ...base } = input();

  it('renders and parses the order line, absent when unset', () => {
    const body = renderParkComment(input({ order: 5 }));
    expect(body).toContain('order: 5');
    expect(readParkState([{ id: 1, body }])?.order).toBe(5);
    expect(renderParkComment(input())).not.toContain('order:');
    expect(readParkState([{ id: 1, body: renderParkComment(input()) }])?.order).toBeUndefined();
  });

  it('parses a malformed order as undefined', () => {
    const body = renderParkComment(input({ order: 5 })).replace('order: 5', 'order: x');
    expect(readParkState([{ id: 1, body }])?.order).toBeUndefined();
  });

  it('upsert keeps the previously recorded order when the input has none', async () => {
    const f = fakeOctokit([{ id: 1, body: renderParkComment(input({ order: 5 })), user: { id: ME } }]);
    await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input() });
    expect(f.store[0].body).toContain('order: 5');
    await upsertParkComment({ octokit: f.octokit, repo: 'o/r', input: input({ order: 9 }) });
    expect(f.store[0].body).toContain('order: 9');
  });

  it('publishParkComment records the single order label', async () => {
    const f = fakeOctokit();
    withLabels(f, ['bug', 'factory:order:7']);
    await publishParkComment({ octokit: f.octokit, repo: 'o/r', input: base });
    expect(f.store[0].body).toContain('order: 7');
  });

  it('publishParkComment skips zero, several or malformed order labels', async () => {
    for (const names of [[], ['factory:order:1', 'factory:order:2'], ['factory:order:x']]) {
      const f = fakeOctokit();
      withLabels(f, names);
      await publishParkComment({ octokit: f.octokit, repo: 'o/r', input: base });
      expect(f.store[0].body).not.toContain('order:');
    }
  });

  it('publishParkComment survives a throwing label read and honours readOrder', async () => {
    const f = fakeOctokit();
    withLabels(f, new Error('boom'));
    expect(await publishParkComment({ octokit: f.octokit, repo: 'o/r', input: base })).toMatchObject({ ok: true });
    expect(f.store[0].body).not.toContain('order:');
    const g = fakeOctokit();
    await publishParkComment({ octokit: g.octokit, repo: 'o/r', input: base, readOrder: async () => 4 });
    expect(g.store[0].body).toContain('order: 4');
  });

  it('readParkedOrder returns the recorded order, undefined without a comment', async () => {
    const f = fakeOctokit([{ id: 1, body: renderParkComment(input({ order: 5 })), user: { id: ME } }]);
    expect(await readParkedOrder({ octokit: f.octokit, repo: 'o/r', issue: K7 })).toBe(5);
    expect(await readParkedOrder({ octokit: fakeOctokit().octokit, repo: 'o/r', issue: K7 })).toBeUndefined();
  });
});
