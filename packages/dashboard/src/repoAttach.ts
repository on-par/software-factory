/** Mirrors core's AttachFailureReason (packages/core/src/daemon/checkout-validation.ts) — the dashboard
 *  cannot import @on-par/factory-core, which is Node-only. The two extra members are app-side:
 *  'daemon-unreachable' for a transport failure, 'unknown-failure' for a reason this build has no
 *  copy for (e.g. a newer daemon). See the ADR shipped with this change. */
export type AttachFailureReason =
  | 'invalid-request'
  | 'not-a-git-checkout'
  | 'origin-mismatch'
  | 'missing-factory-config'
  | 'daemon-unreachable'
  | 'unknown-failure';

export interface AttachRepoInput {
  /** GitHub slug, `owner/name`. */
  repo: string;
  /** Absolute path to the local checkout. */
  path: string;
}

export interface AttachRepoExplanation {
  reason: AttachFailureReason;
  /** Headline naming the missing prerequisite. */
  title: string;
  /** What the operator must do next. */
  remediation: string;
  /** factoryd's own message, shown verbatim and never parsed. */
  detail: string;
}

export type AttachRepoOutcome = { ok: true; slug: string } | { ok: false; explanation: AttachRepoExplanation };

export interface AttachFieldErrors {
  repo?: string;
  path?: string;
}

export interface AttachRepoDeps {
  fetch?: typeof globalThis.fetch;
  url?: string;
}

export const DEFAULT_REPOS_URL = '/repos';

const ATTACH_FAILURE_COPY: Record<AttachFailureReason, { title: string; remediation: string }> = {
  'missing-factory-config': {
    title: 'Factory config required',
    remediation:
      "This checkout's GitHub origin matches, but it has no .factory/config.json. Run `factory init` in the checkout to create one, then attach again.",
  },
  'origin-mismatch': {
    title: 'Repo slug does not match the checkout origin',
    remediation:
      "The checkout's git origin points at a different repository than the slug you entered. Correct the slug, or choose the checkout whose origin is that repository.",
  },
  'not-a-git-checkout': {
    title: 'Not a git checkout',
    remediation: 'That path has no git origin remote. Point the app at a cloned checkout of the repository.',
  },
  'invalid-request': {
    title: 'Attach request rejected',
    remediation:
      'factoryd could not read the request. The repo must be an owner/name slug and the path must be absolute.',
  },
  'daemon-unreachable': {
    title: 'factoryd is not reachable',
    remediation: 'Start the daemon (`factory daemon run`) and try again — the app reaches it over loopback only.',
  },
  'unknown-failure': {
    title: 'Attach failed',
    remediation:
      'factoryd rejected the attach for a reason this app build does not recognize. Its own message is below.',
  },
};

function isKnownReason(reason: string): reason is AttachFailureReason {
  return Object.hasOwn(ATTACH_FAILURE_COPY, reason);
}

/** Pure: the only mapping from factoryd's reason code to operator-facing copy. `detail` is
 *  carried through verbatim — never parsed — so core can reword its messages freely. */
export function explainAttachFailure(reason: string, detail: string): AttachRepoExplanation {
  const known = isKnownReason(reason) ? reason : 'unknown-failure';
  return { reason: known, ...ATTACH_FAILURE_COPY[known], detail };
}

/** Pure: client-side presence checks only (AC "empty fields block submission"). Trims before
 *  checking, so whitespace-only input still prompts. Origin match and config existence are
 *  server-side concerns handled by explainAttachFailure, not here. */
export function validateAttachInput(input: AttachRepoInput): AttachFieldErrors {
  const errors: AttachFieldErrors = {};
  if (input.repo.trim() === '') errors.repo = 'Enter a GitHub repo slug (owner/name).';
  if (input.path.trim() === '') errors.path = 'Enter the absolute local checkout path.';
  return errors;
}

export async function attachRepo(input: AttachRepoInput, deps: AttachRepoDeps = {}): Promise<AttachRepoOutcome> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(deps.url ?? DEFAULT_REPOS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch (err) {
    return {
      ok: false,
      explanation: explainAttachFailure('daemon-unreachable', err instanceof Error ? err.message : String(err)),
    };
  }

  // A 201 means the gate passed and the registry now keys the entry by exactly the slug we
  // posted (core's attachRepo calls upsertRepo with request.repo), so nothing needs reading back.
  if (response.ok) return { ok: true, slug: input.repo };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const body =
    payload !== null && typeof payload === 'object' ? (payload as { error?: unknown; reason?: unknown }) : {};
  return {
    ok: false,
    explanation: explainAttachFailure(
      typeof body.reason === 'string' ? body.reason : '',
      typeof body.error === 'string' ? body.error : `factoryd returned HTTP ${response.status}`,
    ),
  };
}
