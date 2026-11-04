import type { LinearTrackerConfig } from '../config/tracker-section.js';

export const LINEAR_API_KEY_ENV = 'LINEAR_API_KEY';
export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

export type LinearPreflightResult =
  | { kind: 'unauthorized' }
  | { kind: 'team-missing'; teamKey: string }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; readyIssues: number; unmappedProjects: string[] };

const MAX_PAGES = 10;

const QUERY = `query($team: String!, $label: String!, $state: String!, $after: String) {
  teams(filter: { key: { eq: $team } }) { nodes { id } }
  issues(first: 100, after: $after, filter: { team: { key: { eq: $team } }, state: { name: { eq: $state } }, labels: { some: { name: { eq: $label } } } }) {
    nodes { project { id name } }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface GraphqlError {
  message?: string;
  extensions?: { code?: string };
}
interface Page {
  errors?: GraphqlError[];
  data?: {
    teams?: { nodes?: unknown[] };
    issues?: {
      nodes?: { project?: { id: string; name: string } | null }[];
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  };
}

export async function probeLinearSetup(
  input: { apiKey: string; linear: LinearTrackerConfig },
  fetchFn: typeof fetch = fetch,
): Promise<LinearPreflightResult> {
  const { apiKey, linear } = input;
  const redact = (text: string): string => text.split(apiKey).join('***');
  const fail = (message: string): LinearPreflightResult => ({ kind: 'error', message: redact(message) });
  const projects = new Set<string>();
  let readyIssues = 0;
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetchFn(LINEAR_GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({
          query: QUERY,
          variables: { team: linear.teamKey, label: linear.readyLabel, state: linear.states.ready, after },
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    let body: Page | undefined;
    try {
      body = (await res.json()) as Page;
    } catch {
      body = undefined;
    }
    const errors = body?.errors ?? [];
    if (res.status === 401 || res.status === 403 || errors.some((e) => e.extensions?.code === 'AUTHENTICATION_ERROR')) {
      return { kind: 'unauthorized' };
    }
    if (!res.ok) return fail(`HTTP ${res.status}`);
    if (body === undefined) return fail('Linear returned a non-JSON response');
    if (errors.length > 0) return fail(errors[0]?.message ?? 'Linear returned a GraphQL error');
    if ((body.data?.teams?.nodes ?? []).length === 0) return { kind: 'team-missing', teamKey: linear.teamKey };
    const issues = body.data?.issues;
    for (const node of issues?.nodes ?? []) {
      readyIssues++;
      const project = node.project;
      if (project && !(project.name in linear.projects) && !(project.id in linear.projects)) projects.add(project.name);
    }
    const info = issues?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  return { kind: 'ok', readyIssues, unmappedProjects: [...projects].sort() };
}
