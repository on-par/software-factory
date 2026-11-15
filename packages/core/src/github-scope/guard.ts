import type { Octokit } from '@octokit/rest';

import { redactGitHubCredentials } from '../utils/github-credentials.js';
import type { PhaseCredentialHolder } from './broker.js';
import { isMergeRequest, permissionList } from './matrix.js';

export class GitHubScopeError extends Error {
  readonly phase: string;
  readonly method: string;
  readonly route: string;
  readonly fix: string;

  constructor(phase: string, method: string, route: string, reason: string, fix: string) {
    const where = method ? `GitHub call ${method} ${route} refused` : 'GitHub credential refused';
    super(redactGitHubCredentials(`${where} in phase ${phase}: ${reason}. Fix: ${fix}`));
    this.name = 'GitHubScopeError';
    this.phase = phase;
    this.method = method;
    this.route = route;
    this.fix = fix;
  }
}

const holders = new WeakMap<object, PhaseCredentialHolder>();

export function phaseHolderOf(octokit: unknown): PhaseCredentialHolder | undefined {
  return typeof octokit === 'object' && octokit !== null ? holders.get(octokit) : undefined;
}

export function allowScopedMerge(octokit: unknown): void {
  const holder = phaseHolderOf(octokit);
  if (holder?.current()?.phase === 'land') holder.mergeAllowed = true;
}

interface GuardedRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | number | undefined>;
  body?: unknown;
  [param: string]: unknown;
}

function expandRoute(options: GuardedRequest): string {
  const url = options.url ?? '';
  return url.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = options[name];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : match;
  });
}

function targetRepo(route: string): string | undefined {
  const match = /(?:^|\/\/[^/]+)\/repos\/([^/?#]+)\/([^/?#]+)/.exec(route);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function graphqlBody(options: GuardedRequest): unknown {
  const nested = (options.body as { query?: unknown } | null | undefined)?.query;
  return { query: options.query ?? nested };
}

function isIssuesRoute(route: string): boolean {
  return /(?:^|\/\/[^/]+)\/repos\/[^/]+\/[^/]+\/issues(?:[/?#]|$)/.test(route);
}

function isGraphqlRead(route: string, body: unknown): boolean {
  if (!/\/graphql\/?$/.test(route)) return false;
  const query = (body as { query?: unknown } | null | undefined)?.query;
  return typeof query === 'string' && !/\bmutation\b/.test(query);
}

function refusal(phase: string, method: string, route: string, reason: string, fix: string): GitHubScopeError {
  return new GitHubScopeError(phase, method, route, reason, fix);
}

export function installGitHubScopeGuard(
  octokit: Octokit,
  opts: { repo: string; holder: PhaseCredentialHolder },
): Octokit {
  const { repo, holder } = opts;
  octokit.hook.wrap('request', async (request, rawOptions) => {
    const options: GuardedRequest = rawOptions;
    await holder.ensureEntered();
    const state = holder.current();
    const method = (options.method ?? 'GET').toUpperCase();
    const route = expandRoute(options);
    if (!state) throw refusal('unknown', method, route, 'no credential phase entered', 'enter a phase first');
    if (state.failure) throw state.failure;
    if (state.mode === 'none') {
      throw refusal(
        state.phase,
        method,
        route,
        'BUILD holds no GitHub credential',
        'run GitHub calls from plan, ship or land, not from build',
      );
    }
    if (state.mode === 'passthrough') {
      const token = holder.checkToken();
      if (token) options.headers.authorization = `token ${token}`;
      return request(rawOptions);
    }
    const { credential, scope } = state;
    if (!credential || !scope) {
      throw refusal(state.phase, method, route, 'no credential leased', 'check the GitHub credential configuration');
    }
    const target = targetRepo(route);
    if (target && target.toLowerCase() !== repo.toLowerCase()) {
      throw refusal(state.phase, method, route, `credential is scoped to ${repo}`, `only call ${repo} from this run`);
    }
    if (isMergeRequest(method, route, graphqlBody(options)) && !(scope.mayMerge && holder.mergeAllowed)) {
      throw refusal(
        state.phase,
        method,
        route,
        'only the land step may merge, after the trust-tier risk gate',
        'let `factory land` merge once the risk gate allows it',
      );
    }
    if (
      scope.writesLimitedToIssues &&
      method !== 'GET' &&
      method !== 'HEAD' &&
      !isIssuesRoute(route) &&
      !isGraphqlRead(route, graphqlBody(options))
    ) {
      throw refusal(
        state.phase,
        method,
        route,
        `${state.phase} may only write issue comments and labels`,
        'perform this call in ship or land',
      );
    }
    options.headers.authorization = `token ${credential.token}`;
    try {
      return await request(rawOptions);
    } catch (err) {
      const status = (err as { status?: unknown } | null)?.status;
      if (status !== 401 && status !== 403) throw err;
      throw refusal(
        state.phase,
        method,
        route,
        `GitHub answered ${String(status)} for the ${state.phase} credential`,
        `grant the credential ${permissionList(scope)} on ${repo}`,
      );
    }
  });
  holders.set(octokit, holder);
  return octokit;
}
