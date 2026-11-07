// src/utils/github-identity.ts — the GitHub account the factory's own token acts as, for user and App tokens.
//
// REST `GET /user` answers for personal and OAuth tokens. GitHub refuses it for GitHub App installation tokens
// with 403 "Resource not accessible by integration". On that 403 only, GraphQL `viewer` is asked instead and
// accepted only when it is a Bot. Every other failure is rethrown, so a real auth error never turns into
// "no identity".

import type { Octokit } from '@octokit/rest';

export interface SelfIdentity {
  /** REST user id. Undefined only when GraphQL reports a bot without a database id. */
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
const VIEWER_QUERY = 'query { viewer { __typename login ... on Bot { databaseId } } }';

interface ViewerResponse {
  viewer?: { __typename?: string; login?: string; databaseId?: number | null };
}

const isForbidden = (err: unknown): boolean => (err as { status?: unknown } | null)?.status === 403;

/** Resolves the authenticated account. Fails closed: only a 403 answered by a GraphQL Bot viewer falls back. */
export async function resolveSelfIdentity(octokit: SelfIdentityOctokit): Promise<SelfIdentity> {
  try {
    const { data } = await octokit.rest.users.getAuthenticated();
    return { id: data.id, login: data.login, kind: data.type === 'Bot' ? 'bot' : 'user' };
  } catch (err) {
    if (!isForbidden(err) || octokit.graphql === undefined) throw err;
    const { viewer } = await octokit.graphql<ViewerResponse>(VIEWER_QUERY);
    const login = viewer?.login ?? '';
    if (viewer?.__typename !== 'Bot' || login === '') throw err;
    const id = typeof viewer?.databaseId === 'number' ? viewer.databaseId : undefined;
    return { id, login: login.endsWith(BOT_SUFFIX) ? login : `${login}${BOT_SUFFIX}`, kind: 'bot' };
  }
}

/** True only for content written by `self`: same id when known, else the exact bot login on a Bot author. */
export function isOwnComment(author: GitHubAuthor | null | undefined, self: SelfIdentity): boolean {
  if (author === null || author === undefined) return false;
  if (self.id !== undefined) return author.id === self.id;
  return self.kind === 'bot' && author.type === 'Bot' && author.login === self.login;
}
