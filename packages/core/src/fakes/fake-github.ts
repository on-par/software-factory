import { Octokit } from '@octokit/rest';

export interface FakeGitHubRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export type FakeGitHubRoute = readonly [route: string | RegExp, reply: (request: FakeGitHubRequest) => unknown];

export interface FakeGitHub {
  octokit: Octokit;
  requests: FakeGitHubRequest[];
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export const githubError = (status: number, message: string): Response =>
  new Response(JSON.stringify({ message }), { status, headers: JSON_HEADERS });

const readBody = (body: RequestInit['body']): unknown => {
  if (typeof body !== 'string' || body === '') return undefined;
  const parsed: unknown = JSON.parse(body);
  return parsed;
};

const matches = (route: string | RegExp, key: string): boolean =>
  typeof route === 'string' ? route === key : route.test(key);

export function createFakeGitHub(routes: readonly FakeGitHubRoute[]): FakeGitHub {
  const requests: FakeGitHubRequest[] = [];
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const request = { method, path: url.pathname, query: url.searchParams, body: readBody(init?.body) };
    requests.push(request);
    const route = routes.find(([pattern]) => matches(pattern, `${method} ${url.pathname}`));
    if (!route) return githubError(404, 'Not Found');
    const reply = await route[1](request);
    return reply instanceof Response ? reply : new Response(JSON.stringify(reply), { headers: JSON_HEADERS });
  };
  return { octokit: new Octokit({ request: { fetch } }), requests };
}
