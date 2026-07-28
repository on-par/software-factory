import { describe, expect, it } from 'vitest';

import {
  createDefaultWorkSourceRegistry,
  InvalidWorkRequestInputError,
  UnsupportedWorkSourceError,
  type WorkRequest,
  WorkSourceRegistry,
} from './index.js';

function fakeAdapter(kind: string, request: WorkRequest) {
  return { kind, resolve: async () => request };
}

describe('WorkSourceRegistry', () => {
  it('resolve returns the adapter request for a registered kind', async () => {
    const request: WorkRequest = { id: 'x:1', kind: 'x', title: 'T', brief: 'B', acceptanceCriteria: [] };
    const registry = new WorkSourceRegistry().register(fakeAdapter('x', request));

    await expect(registry.resolve('x', {})).resolves.toEqual(request);
  });

  it('rejects with UnsupportedWorkSourceError for an unregistered kind', async () => {
    const request: WorkRequest = { id: 'x:1', kind: 'x', title: 'T', brief: 'B', acceptanceCriteria: [] };
    const registry = new WorkSourceRegistry().register(fakeAdapter('x', request));

    await expect(registry.resolve('jira', {})).rejects.toBeInstanceOf(UnsupportedWorkSourceError);
    try {
      await registry.resolve('jira', {});
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedWorkSourceError);
      const unsupported = err as UnsupportedWorkSourceError;
      expect(unsupported.message).toContain('"jira"');
      expect(unsupported.message).toContain('x');
      expect(unsupported.kind).toBe('jira');
      expect(unsupported.supported).toEqual(['x']);
    }
  });

  it('reports "registered sources: none" for an empty registry', async () => {
    const registry = new WorkSourceRegistry();

    try {
      await registry.resolve('jira', {});
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as Error).message).toContain('registered sources: none');
    }
  });

  it('has()/kinds() reflect registrations, and re-registering the same kind replaces it', async () => {
    const requestA: WorkRequest = { id: 'x:a', kind: 'x', title: 'A', brief: '', acceptanceCriteria: [] };
    const requestB: WorkRequest = { id: 'x:b', kind: 'x', title: 'B', brief: '', acceptanceCriteria: [] };
    const registry = new WorkSourceRegistry();

    expect(registry.has('x')).toBe(false);
    expect(registry.kinds()).toEqual([]);

    registry.register(fakeAdapter('x', requestA));
    expect(registry.has('x')).toBe(true);
    expect(registry.kinds()).toEqual(['x']);

    registry.register(fakeAdapter('x', requestB));
    expect(registry.kinds()).toEqual(['x']);
    await expect(registry.resolve('x', {})).resolves.toEqual(requestB);
  });
});

describe('createDefaultWorkSourceRegistry', () => {
  it('registers the github-issue adapter and resolves through it', async () => {
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'A title', body: 'A body', html_url: 'https://x' } }),
        },
      },
    };
    const registry = createDefaultWorkSourceRegistry({ octokit });

    expect(registry.has('github-issue')).toBe(true);
    const request = await registry.resolve('github-issue', { repo: 'on-par/software-factory', issue: 1 });
    expect(request.title).toBe('A title');
  });
});

describe('InvalidWorkRequestInputError', () => {
  it('carries the source kind and a descriptive message', () => {
    const err = new InvalidWorkRequestInputError('github-issue', 'bad shape');
    expect(err.name).toBe('InvalidWorkRequestInputError');
    expect(err.kind).toBe('github-issue');
    expect(err.message).toBe('invalid input for work-request source "github-issue": bad shape');
  });
});
