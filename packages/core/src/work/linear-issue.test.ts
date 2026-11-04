import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { InvalidWorkRequestInputError } from './index.js';
import { createLinearIssueAdapter, parseLinearIssueRef } from './linear-issue.js';

function load(name: string) {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'));
}

function setup(body: unknown, env: Record<string, string | undefined> = { LINEAR_API_KEY: 'test-key' }) {
  const fetchDouble = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  return { fetchDouble, adapter: createLinearIssueAdapter({ fetch: fetchDouble, env }) };
}

describe('linear-issue adapter', () => {
  it('resolves ON-12 from a recorded response into an open work request', async () => {
    const fixture = load('linear-issue-on-12.json');
    const { adapter } = setup(fixture);
    const req = await adapter.resolve('ON-12');

    expect(req.key).toBe('ON-12');
    expect(req.id).toBe('linear-issue:ON-12');
    expect(req.kind).toBe('linear-issue');
    expect(req.title).toBe(fixture.data.issue.title);
    expect(req.brief).toBe(fixture.data.issue.description);
    expect(req.acceptanceCriteria).toEqual(['first criterion', 'second criterion']);
    expect(req.state).toBe('open');
  });

  it('maps a canceled state type to closed', async () => {
    const req = await setup(load('linear-issue-on-13.json')).adapter.resolve('ON-13');
    expect(req.state).toBe('closed');
  });

  it('maps a completed state type to closed', async () => {
    const body = load('linear-issue-on-12.json');
    body.data.issue.state.type = 'completed';
    expect((await setup(body).adapter.resolve('ON-12')).state).toBe('closed');
  });

  it('rejects a GitHub issue URL with a usage error naming the expected form', async () => {
    const { adapter, fetchDouble } = setup(load('linear-issue-on-12.json'));
    const p = adapter.resolve('https://github.com/on-par/software-factory/issues/12');

    await expect(p).rejects.toBeInstanceOf(InvalidWorkRequestInputError);
    await expect(p).rejects.toThrow(/"ON-12"/);
    await expect(p).rejects.toThrow('https://linear.app/<workspace>/issue/ON-12');
    expect(fetchDouble).not.toHaveBeenCalled();
  });

  it('parses a bare key and a linear.app issue URL to the same key', () => {
    for (const input of [
      'ON-12',
      'on-12',
      ' ON-12 ',
      'https://linear.app/acme/issue/ON-12',
      'https://linear.app/acme/issue/ON-12/some-slug',
    ]) {
      expect(parseLinearIssueRef(input)).toBe('ON-12');
    }
  });

  it('rejects other hosts and malformed keys', async () => {
    const { adapter, fetchDouble } = setup(load('linear-issue-on-12.json'));
    for (const input of [
      'https://linear.app.evil.com/acme/issue/ON-12',
      'http://linear.app/acme/issue/ON-12',
      'https://linear.app/acme/project/x',
      'ON12',
      '12',
      '',
      { ref: 42 },
    ]) {
      await expect(adapter.resolve(input)).rejects.toBeInstanceOf(InvalidWorkRequestInputError);
    }
    expect(fetchDouble).not.toHaveBeenCalled();
  });

  it('truncates a long echoed input', () => {
    expect(() => parseLinearIssueRef('x'.repeat(500))).toThrow(/…/);
  });

  it('carries labels, url and the UUID reference', async () => {
    const req = await setup(load('linear-issue-on-12.json')).adapter.resolve('ON-12');

    expect(req.labels).toEqual(['factory:ready', 'enhancement']);
    expect(req.reference).toEqual({
      externalId: '00000000-0000-4000-8000-000000000012',
      url: 'https://linear.app/example/issue/ON-12/sample',
    });
  });

  it('fails fast when LINEAR_API_KEY is missing', async () => {
    const { adapter, fetchDouble } = setup(load('linear-issue-on-12.json'), {});

    await expect(adapter.resolve('ON-12')).rejects.toThrow(/LINEAR_API_KEY/);
    expect(fetchDouble).not.toHaveBeenCalled();
  });

  it('accepts { ref } params as well as a bare string', async () => {
    const req = await setup(load('linear-issue-on-12.json')).adapter.resolve({ ref: 'ON-12' });
    expect(req.key).toBe('ON-12');
  });
});
