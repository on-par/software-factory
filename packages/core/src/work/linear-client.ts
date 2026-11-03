// packages/core/src/work/linear-client.ts — read-only Linear GraphQL client (#3889).

import { z } from 'zod';

const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

const ISSUE_QUERY = `query FactoryIssue($id: String!) {
  issue(id: $id) {
    id identifier title description url
    state { type }
    labels { nodes { name } }
  }
}`;

const IssueSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string(),
  description: z.string().nullable().optional(),
  url: z.url(),
  state: z.object({ type: z.string() }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
});

const ResponseSchema = z.object({
  data: z.object({ issue: IssueSchema.nullable() }).nullable().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

export type LinearIssueRecord = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  stateType: string;
  labels: string[];
};

export class LinearApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinearApiError';
  }
}

export function createLinearClient(opts: {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  timeoutMs?: number;
}): { fetchIssue(ref: string): Promise<LinearIssueRecord> } {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  return {
    async fetchIssue(ref) {
      const res = await fetchImpl(opts.endpoint ?? LINEAR_GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: opts.apiKey },
        body: JSON.stringify({ query: ISSUE_QUERY, variables: { id: ref } }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      if (!res.ok) {
        throw new LinearApiError(`Linear API returned HTTP ${res.status} for ${ref}`);
      }
      const parsed = ResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const where = first ? `${first.path.join('.')}: ${first.message}` : 'unknown';
        throw new LinearApiError(`malformed Linear response for ${ref}: ${where}`);
      }
      const { data, errors } = parsed.data;
      if (errors && errors.length > 0) {
        throw new LinearApiError(`Linear API error for ${ref}: ${errors.map((e) => e.message).join('; ')}`);
      }
      const issue = data?.issue;
      if (issue == null) {
        throw new LinearApiError(`Linear issue ${ref} not found`);
      }
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? '',
        url: issue.url,
        stateType: issue.state.type,
        labels: issue.labels.nodes.map((l) => l.name),
      };
    },
  };
}
