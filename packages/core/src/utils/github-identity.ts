// src/utils/github-identity.ts — the GitHub account the factory's own token acts as, for user and App tokens.
//
// REST `GET /user` answers for personal and OAuth tokens. GitHub refuses it for GitHub App installation tokens
// with 403 "Resource not accessible by integration". On that 403 only, GraphQL `viewer` is asked instead.
// GitHub's schema types `viewer` as `User!`, so the query asks only `User` fields; a `... on Bot` spread fails
// schema validation for every token. The answer is accepted only when it is unmistakably an App's bot account
// (see `appBotIdentity`). Every other failure is rethrown, so a real auth error never turns into "no identity".

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
 * A login ending in `[bot]` is a bot account (user logins cannot contain `[`), so it is taken with its numeric
 * database id. A login without the suffix is taken only when REST `GET /users/{login}[bot]` names a Bot with that
 * same id. A missing id is never accepted: own-comment checks would fall back to login matching on weaker evidence.
 */
async function appBotIdentity(octokit: GraphqlOctokit): Promise<SelfIdentity | undefined> {
  const { viewer } = await octokit.graphql<ViewerResponse>(VIEWER_QUERY);
  const login = typeof viewer?.login === 'string' ? viewer.login : '';
  const id = viewer?.databaseId;
  if (login === '' || typeof id !== 'number') return undefined;
  if (login.endsWith(BOT_SUFFIX)) return { id, login, kind: 'bot' };
  let account: { id?: unknown; login?: unknown; type?: unknown };
  try {
    ({ data: account } = await octokit.rest.users.getByUsername({ username: `${login}${BOT_SUFFIX}` }));
  } catch (err) {
    if (statusOf(err) === 404) return undefined;
    throw err;
  }
  if (account.type !== 'Bot' || account.id !== id || typeof account.login !== 'string') return undefined;
  return { id, login: account.login, kind: 'bot' };
}

/** Resolves the authenticated account. Fails closed: only a 403 answered by an App bot viewer falls back. */
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
