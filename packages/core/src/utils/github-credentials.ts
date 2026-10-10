// src/utils/github-credentials.ts — keep GitHub credentials out of child processes that don't need them.
//
// The factory's own GitHub access goes through Octokit in-process, plus a few
// `gh`/`git` subprocesses. Every other child — the agent CLIs (claude, codex,
// opencode) running with bypassed permissions, the verify commands they
// propose, and the checker commands that execute agent-written code — must not
// inherit GITHUB_TOKEN/GH_TOKEN or any other GitHub credential from the
// factory's environment. Callers that genuinely need the credential opt in per
// call (`githubAuth: true`); everything else gets a scrubbed environment.

/** Credential variables that don't follow the GITHUB_* / GH_* *_TOKEN naming
 *  but still grant GitHub access (Actions runtime tokens). */
const EXTRA_CREDENTIAL_VARS = new Set(['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']);

const GITHUB_SEGMENT = /(?:^|_)(?:GITHUB|GH)(?:_|$)/;
const CREDENTIAL_SUFFIX = /(?:TOKEN|PAT|PASSWORD|SECRET|PRIVATE_KEY|CREDENTIALS?)$/;

/** True for env var names that carry a GitHub credential: GITHUB_TOKEN,
 *  GH_TOKEN, GITHUB_PAT, GH_ENTERPRISE_TOKEN, GITHUB_ENTERPRISE_TOKEN,
 *  COPILOT_GITHUB_TOKEN, GITHUB_APP_PRIVATE_KEY, … Case-insensitive. */
export function isGitHubCredentialEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  if (EXTRA_CREDENTIAL_VARS.has(upper)) return true;
  return GITHUB_SEGMENT.test(upper) && CREDENTIAL_SUFFIX.test(upper);
}

/** Copy of `env` with every GitHub credential variable removed. */
export function withoutGitHubCredentials<V>(env: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isGitHubCredentialEnvVar(key)) out[key] = value;
  }
  return out;
}

/**
 * The complete environment for a factory child process: `overrides` merged
 * over `parent`. Unless `githubAuth` is set, GitHub credentials are stripped
 * from both — an explicit override can't smuggle one back in either.
 */
export function childProcessEnv<V extends string | undefined>(
  parent: Record<string, string | undefined>,
  overrides: Record<string, V> | undefined,
  options: { githubAuth?: boolean } = {},
): Record<string, string | V | undefined> {
  const merged = { ...parent, ...overrides };
  return options.githubAuth ? merged : withoutGitHubCredentials(merged);
}

/** Literal GitHub token shapes (classic PATs, OAuth/user/server/refresh tokens, fine-grained PATs). */
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)/g;

/** Values shorter than this are not treated as secrets for value-based
 *  redaction — masking e.g. "1" everywhere would destroy the text. */
const MIN_SECRET_LENGTH = 8;

/**
 * Masks GitHub credentials in `text`: the literal value of every GitHub
 * credential variable in `env` (so an opaque token with no known prefix is
 * still caught) and anything shaped like a GitHub token.
 */
export function redactGitHubCredentials(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  for (const [key, value] of Object.entries(env)) {
    if (!isGitHubCredentialEnvVar(key) || value === undefined || value.length < MIN_SECRET_LENGTH) continue;
    out = out.split(value).join('[redacted]');
  }
  return out.replace(GITHUB_TOKEN_PATTERN, '[redacted]');
}

/** Redacts GitHub credentials in place on a child-process rejection's
 *  message/stack/cmd/stdout/stderr, then returns it for rethrowing. */
export function redactExecError<E>(err: E, env: Record<string, string | undefined> = process.env): E {
  if (typeof err !== 'object' || err === null) return err;
  const e = err as Record<string, unknown>;
  for (const field of ['message', 'stack', 'cmd', 'stdout', 'stderr']) {
    const value = e[field];
    if (typeof value === 'string') e[field] = redactGitHubCredentials(value, env);
  }
  return err;
}
