import type { Octokit } from '@octokit/rest';

export interface SelfIdentity {
  id: number | undefined;
  login: string;
  kind: 'user' | 'bot';
}

export interface GitHubAuthor {
  id?: number;
  login?: string;
  type?: string;
}

export type SelfIdentityOctokit = Pick<Octokit, 'rest'> & Partial<Pick<Octokit, 'graphql'>>;

const BOT_SUFFIX = '[bot]';
const VIEWER_QUERY = 'query { viewer { login databaseId } }';

interface ViewerResponse {
  viewer?: { login?: unknown; databaseId?: unknown } | null;
}

type GraphqlOctokit = SelfIdentityOctokit & Pick<Octokit, 'graphql'>;

const statusOf = (err: unknown): unknown => (err as { status?: unknown } | null)?.status;
const hasGraphql = (octokit: SelfIdentityOctokit): octokit is GraphqlOctokit => octokit.graphql !== undefined;

async function appBotIdentity(octokit: GraphqlOctokit): Promise<SelfIdentity | undefined> {
  const { viewer } = await octokit.graphql<ViewerResponse>(VIEWER_QUERY);
  const login = typeof viewer?.login === 'string' ? viewer.login : '';
  const id = viewer?.databaseId;
  if (login === '' || typeof id !== 'number') return undefined;
  const botLogin = login.endsWith(BOT_SUFFIX) ? login : `${login}${BOT_SUFFIX}`;
  let account: { id?: unknown; login?: unknown; type?: unknown };
  try {
    ({ data: account } = await octokit.rest.users.getByUsername({ username: botLogin }));
  } catch (err) {
    if (statusOf(err) === 404) return undefined;
    throw err;
  }
  if (account.type !== 'Bot' || account.id !== id || typeof account.login !== 'string') return undefined;
  return { id, login: account.login, kind: 'bot' };
}

export async function resolveSelfIdentity(octokit: SelfIdentityOctokit): Promise<SelfIdentity> {
  try {
    const { data } = await octokit.rest.users.getAuthenticated();
    return { id: data.id, login: data.login, kind: data.type === 'Bot' ? 'bot' : 'user' };
  } catch (err) {
    if (statusOf(err) !== 403 || !hasGraphql(octokit)) throw err;
    const bot = await appBotIdentity(octokit);
    if (bot === undefined) throw err;
    return bot;
  }
}

export function isOwnComment(author: GitHubAuthor | null | undefined, self: SelfIdentity): boolean {
  if (author === null || author === undefined) return false;
  if (self.id !== undefined) return author.id === self.id;
  return self.kind === 'bot' && author.type === 'Bot' && author.login === self.login;
}
