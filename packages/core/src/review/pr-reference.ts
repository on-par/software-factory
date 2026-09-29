// packages/core/src/review/pr-reference.ts — parse `factory review <pr>` references: number, owner/repo#N, or a github.com pull URL (#1673).

/** Exit code for a review whose PR cannot be read (missing repo/PR or a token without access). */
export const REVIEW_ACCESS_ERROR_EXIT_CODE = 2;

export interface PullRequestReference {
  /** `owner/name`, or null for a bare number (the current checkout's repo). */
  repo: string | null;
  number: number;
}

export type PullRequestReferenceParse = { ok: true; ref: PullRequestReference } | { ok: false; error: string };

export interface ResolvedPullRequest {
  repo: string;
  number: number;
  /** `owner/repo#N`. */
  display: string;
}

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const NAME = '[A-Za-z0-9._-]+';
const BARE_NUMBER = /^#?(\d+)$/;
const SHORTHAND = new RegExp(`^(${OWNER})/(${NAME})#(\\d+)$`);
const PULL_URL =
  /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:\/(?:files|commits|checks))?\/?(?:[?#].*)?$/i;
const OWNER_ONLY = new RegExp(`^${OWNER}$`);
const NAME_ONLY = new RegExp(`^${NAME}$`);

function malformed(input: string): PullRequestReferenceParse {
  return {
    ok: false,
    error: `invalid pull request reference '${input}' — use a number, owner/repo#N, or https://github.com/owner/repo/pull/N`,
  };
}

function build(input: string, repo: string | null, rawNumber: string): PullRequestReferenceParse {
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number <= 0) return malformed(input);
  return { ok: true, ref: { repo, number } };
}

export function parsePullRequestReference(input: string): PullRequestReferenceParse {
  const text = input.trim();

  const bare = BARE_NUMBER.exec(text);
  if (bare) return build(input, null, bare[1] ?? '');

  const short = SHORTHAND.exec(text);
  if (short) return build(input, `${short[1]}/${short[2]}`, short[3] ?? '');

  const url = PULL_URL.exec(text);
  if (url) {
    const [, owner = '', name = '', num = ''] = url;
    if (!OWNER_ONLY.test(owner) || !NAME_ONLY.test(name)) return malformed(input);
    return build(input, `${owner}/${name}`, num);
  }

  if (/^https?:\/\/(?:www\.)?github\.com(?:[/?#]|$)/i.test(text)) return malformed(input);
  if (/^https?:\/\//i.test(text)) {
    return { ok: false, error: `only github.com pull request URLs are supported: ${input}` };
  }
  return malformed(input);
}

export function formatPullRequestReference(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function resolvePullRequestReference(
  ref: PullRequestReference,
  currentRepo: string | null,
): ResolvedPullRequest | { error: string } {
  const repo = ref.repo ?? currentRepo;
  if (!repo) {
    return {
      error: 'a bare PR number needs a GitHub repository for the current checkout; pass owner/repo#N or a PR URL',
    };
  }
  return { repo, number: ref.number, display: formatPullRequestReference(repo, ref.number) };
}

export function describePullRequestAccessError(pr: ResolvedPullRequest, detail: string): string {
  return `review refused: cannot read ${pr.display} — ${detail.trim() || 'access denied'}. Check that the repository exists and that your GitHub token can read it. No code was checked out and no checker ran.`;
}
