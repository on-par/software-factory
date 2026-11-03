// packages/core/src/work/linear-client.ts — minimal typed Linear GraphQL client over fetch (#3889).
import { z } from 'zod';

export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

const ISSUE_QUERY = `query FactoryIssue($id: String!) {
  issue(id: $id) {
    id identifier title description url
    state { type }
    labels { nodes { name } }
  }
}`;

const issueSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string(),
  description: z.string().nullable().optional(),
  url: z.url(),
  state: z.object({ type: z.string() }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
});

const responseSchema = z.object({
  data: z.object({ issue: issueSchema.nullable() }).nullable().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

/** Flat record of a Linear issue — the only shape the adapter sees. */
export interface LinearIssueRecord {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  stateType: string;
  labels: string[];
}

export interface LinearIssueClient {
  fetchIssue(key: string): Promise<LinearIssueRecord>;
}

export function createLinearClient(deps: {
  apiKey: () => string | undefined;
  fetch?: typeof fetch;
  endpoint?: string;
}): LinearIssueClient {
  return {
    async fetchIssue(issueKey: string): Promise<LinearIssueRecord> {
      const key = deps.apiKey()?.trim();
      if (!key) {
        throw new Error('LINEAR_API_KEY is not set — export a Linear personal API key to read Linear issues');
      }
      const doFetch = deps.fetch ?? globalThis.fetch;
      const res = await doFetch(deps.endpoint ?? LINEAR_GRAPHQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: key },
        body: JSON.stringify({ query: ISSUE_QUERY, variables: { id: issueKey } }),
      });
      if (!res.ok) {
        throw new Error(`Linear API request for ${issueKey} failed: HTTP ${res.status}`);
      }
      const json: unknown = await res.json();
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(`Linear API returned an unexpected response for ${issueKey}: ${z.prettifyError(parsed.error)}`);
      }
      const errors = parsed.data.errors ?? [];
      if (errors.length > 0) {
        throw new Error(`Linear API error for ${issueKey}: ${errors.map((e) => e.message).join('; ')}`);
      }
      const issue = parsed.data.data?.issue;
      if (!issue) {
        throw new Error(`Linear issue ${issueKey} not found`);
      }
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? null,
        url: issue.url,
        stateType: issue.state.type,
        labels: issue.labels.nodes.map((n) => n.name).filter((n) => n !== ''),
      };
    },
  };
}
