// src/utils/github-identity.ts — the GitHub account the factory's own token acts as, for user and App tokens.
//
// REST `GET /user` answers for personal and OAuth tokens. GitHub refuses it for GitHub App installation tokens
// with 403 "Resource not accessible by integration". On that 403 only, GraphQL `viewer` is asked instead.
// GitHub's schema types `viewer` as `User!`, so the query asks only `User` fields; a `... on Bot` spread fails
// schema validation for every token. The answer is accepted only when REST confirms it is an App's bot account
// with the same id (see `appBotIdentity`). Every other failure is rethrown, so a real auth error never turns into
// "no identity".

import type { Octokit } from '@octokit/rest';

export interface SelfIdentity {
  /** REST user id. `resolveSelfIdentity` always sets it; it stays optional for identities known only by login. */
  id: number | undefined;
  /** Login as REST comment authors carry it: an App's bot account ends in `[bot]`. */
  login: string;
  kind: 'user' | 'bot';
}

/** The author fields of a REST comment, review or similar object. */
export interface GitHubAuthor {
  id?: number;
  login?: string;
  type?: string;
}

export type SelfIdentityOctokit = Pick<Octokit, 'rest'> & Partial<Pick<Octokit, 'graphql'>>;

const BOT_SUFFIX = '[bot]';
/** Only fields that exist on `User`, the schema type of `viewer` (checked by scripts/github-graphql-documents.test.ts). */
const VIEWER_QUERY = 'query { viewer { login databaseId } }';

interface ViewerResponse {
  viewer?: { login?: unknown; databaseId?: unknown } | null;
}

type GraphqlOctokit = SelfIdentityOctokit & Pick<Octokit, 'graphql'>;

const statusOf = (err: unknown): unknown => (err as { status?: unknown } | null)?.status;
const hasGraphql = (octokit: SelfIdentityOctokit): octokit is GraphqlOctokit => octokit.graphql !== undefined;

/**
 * The App bot account behind an installation token, or undefined when the viewer is not unmistakably one.
 * Whatever GraphQL reports, the answer is checked through REST: `GET /users/{login}[bot]` (the suffix added when the
 * viewer login lacks it) must name a Bot whose id equals the viewer's `databaseId`. So the identity never depends
 * on how GraphQL reports the id: if `databaseId` were some other number (an App id, say), it could belong to a real
 * user, and own-comment checks would trust that user. A missing id is never accepted either: own-comment checks
 * would fall back to login matching on weaker evidence.
 */
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

/** Resolves the authenticated account. Fails closed: only a 403 answered by a REST-confirmed App bot falls back. */
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

/** True only for content written by `self`: same id when known, else the exact bot login on a Bot author. */
export function isOwnComment(author: GitHubAuthor | null | undefined, self: SelfIdentity): boolean {
  if (author === null || author === undefined) return false;
  if (self.id !== undefined) return author.id === self.id;
  return self.kind === 'bot' && author.type === 'Bot' && author.login === self.login;
}
