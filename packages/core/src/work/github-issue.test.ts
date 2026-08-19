import { describe, expect, it } from 'vitest';

import { InvalidWorkRequestInputError } from './index.js';
import { createGithubIssueAdapter, createOctokitIssueClient, type WorkIssueClient } from './github-issue.js';

const FACTORY_TASK_BODY = `### Problem statement

The widget flickers.

### Acceptance criteria

\`\`\`gherkin
Given the widget
When it loads
Then it does not flicker
\`\`\`

- [ ] Widget no longer flickers
- [x] Regression test added
`;

function fakeClient(response: {
  title: string;
  body: string | null;
  htmlUrl?: string;
  state?: 'open' | 'closed';
}): WorkIssueClient {
  return { fetchIssue: async () => response };
}

describe('createGithubIssueAdapter', () => {
  it('maps a full factory-task body to a canonical WorkRequest', async () => {
    const client = fakeClient({
      title: 'Fix widget flicker',
      body: FACTORY_TASK_BODY,
      htmlUrl: 'https://github.com/on-par/software-factory/issues/505',
    });
    const adapter = createGithubIssueAdapter(client);

    const request = await adapter.resolve({ repo: 'on-par/software-factory', issue: 505 });

    expect(request.id).toBe('github-issue:on-par/software-factory#505');
    expect(request.kind).toBe('github-issue');
    expect(request.title).toBe('Fix widget flicker');
    expect(request.brief).toBe(FACTORY_TASK_BODY);
    expect(request.reference).toEqual({
      externalId: '505',
      repo: 'on-par/software-factory',
      url: 'https://github.com/on-par/software-factory/issues/505',
    });
  });

  it('extracts acceptance criteria from a fenced gherkin block plus checkboxes, in document order', async () => {
    const client = fakeClient({ title: 'Fix widget flicker', body: FACTORY_TASK_BODY });
    const adapter = createGithubIssueAdapter(client);

    const request = await adapter.resolve({ repo: 'on-par/software-factory', issue: 505 });

    expect(request.acceptanceCriteria).toEqual([
      'Given the widget',
      'When it loads',
      'Then it does not flicker',
      'Widget no longer flickers',
      'Regression test added',
    ]);
  });

  it('returns an empty acceptanceCriteria array when there is no Acceptance criteria section', async () => {
    const client = fakeClient({ title: 'No AC', body: '### Problem statement\n\nSomething.\n' });
    const adapter = createGithubIssueAdapter(client);

    const request = await adapter.resolve({ repo: 'o/r', issue: 1 });

    expect(request.acceptanceCriteria).toEqual([]);
  });

  it('returns an empty acceptanceCriteria array when the Acceptance criteria section is blank', async () => {
    const client = fakeClient({
      title: 'Blank AC',
      body: '### Acceptance criteria\n\n### Verification\n\nrun tests\n',
    });
    const adapter = createGithubIssueAdapter(client);

    const request = await adapter.resolve({ repo: 'o/r', issue: 1 });

    expect(request.acceptanceCriteria).toEqual([]);
  });

  it('maps a null body to an empty brief and empty acceptanceCriteria', async () => {
    const client = fakeClient({ title: 'No body', body: null });
    const adapter = createGithubIssueAdapter(client);

    const request = await adapter.resolve({ repo: 'o/r', issue: 1 });

    expect(request.brief).toBe('');
    expect(request.acceptanceCriteria).toEqual([]);
  });

  it('falls back reference.url to the canonical GitHub URL when the client has no htmlUrl', async () => {
    const client = fakeClient({ title: 'No html url', body: 'Body' });
    const adapter = createGithubIssueAdapter(client);

    const request = await adapter.resolve({ repo: 'on-par/software-factory', issue: 42 });

    expect(request.reference?.url).toBe('https://github.com/on-par/software-factory/issues/42');
  });

  it('puts the client-reported state on the resolved WorkRequest', async () => {
    const client = fakeClient({ title: 'Closed issue', body: 'Body', state: 'closed' });
    const adapter = createGithubIssueAdapter(client);

    const request = await adapter.resolve({ repo: 'on-par/software-factory', issue: 505 });

    expect(request.state).toBe('closed');
  });

  it('leaves state undefined when the client omits it (fail-open)', async () => {
    const client = fakeClient({ title: 'No state', body: 'Body' });
    const adapter = createGithubIssueAdapter(client);

    const request = await adapter.resolve({ repo: 'on-par/software-factory', issue: 505 });

    expect(request.state).toBeUndefined();
  });

  it.each([
    ['empty object', {}],
    ['no-slash repo', { repo: 'noslash', issue: 1 }],
    ['non-positive issue', { repo: 'o/r', issue: 0 }],
    ['non-integer issue', { repo: 'o/r', issue: 1.5 }],
    ['null params', null],
    ['string params', 'string'],
  ])('rejects with InvalidWorkRequestInputError for %s and never calls the client', async (_label, params) => {
    let called = false;
    const client: WorkIssueClient = {
      fetchIssue: async () => {
        called = true;
        return { title: '', body: '' };
      },
    };
    const adapter = createGithubIssueAdapter(client);

    await expect(adapter.resolve(params)).rejects.toBeInstanceOf(InvalidWorkRequestInputError);
    expect(called).toBe(false);
  });
});

describe('createOctokitIssueClient', () => {
  it('maps an octokit-shaped fake response, passing owner/repo/issue_number through', async () => {
    let captured: { owner: string; repo: string; issue_number: number } | undefined;
    const octokit: any = {
      rest: {
        issues: {
          get: async (input: { owner: string; repo: string; issue_number: number }) => {
            captured = input;
            return { data: { title: 'A title', body: 'A body', html_url: 'https://x', state: 'open' } };
          },
        },
      },
    };

    const client = createOctokitIssueClient(octokit);
    const result = await client.fetchIssue({ owner: 'on-par', repo: 'software-factory', issue_number: 505 });

    expect(captured).toEqual({ owner: 'on-par', repo: 'software-factory', issue_number: 505 });
    expect(result).toEqual({ title: 'A title', body: 'A body', htmlUrl: 'https://x', state: 'open' });
  });

  it('turns a body of undefined into null', async () => {
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'A title', body: undefined } }),
        },
      },
    };

    const client = createOctokitIssueClient(octokit);
    const result = await client.fetchIssue({ owner: 'o', repo: 'r', issue_number: 1 });

    expect(result.body).toBeNull();
  });

  it('maps data.state "closed" to state "closed"', async () => {
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'A title', body: 'A body', state: 'closed' } }),
        },
      },
    };

    const client = createOctokitIssueClient(octokit);
    const result = await client.fetchIssue({ owner: 'o', repo: 'r', issue_number: 1 });

    expect(result.state).toBe('closed');
  });

  it('maps any non-"closed" data.state (including absent) to state "open" — fail-open', async () => {
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'A title', body: 'A body' } }),
        },
      },
    };

    const client = createOctokitIssueClient(octokit);
    const result = await client.fetchIssue({ owner: 'o', repo: 'r', issue_number: 1 });

    expect(result.state).toBe('open');
  });
});
