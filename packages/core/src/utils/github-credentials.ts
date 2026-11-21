const ACTIONS_RUNTIME_CREDENTIAL_VARS = new Set(['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']);

const GITHUB_SEGMENT = /(?:^|_)(?:GITHUB|GH)(?:_|$)/;
const CREDENTIAL_SUFFIX = /(?:TOKEN(?:_(?:PLAN|SHIP|LAND))?|PAT|PASSWORD|SECRET|PRIVATE_KEY|CREDENTIALS?)$/;

export function isGitHubCredentialEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  if (ACTIONS_RUNTIME_CREDENTIAL_VARS.has(upper)) return true;
  return GITHUB_SEGMENT.test(upper) && CREDENTIAL_SUFFIX.test(upper);
}

export function withoutGitHubCredentials<V>(env: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isGitHubCredentialEnvVar(key)) out[key] = value;
  }
  return out;
}

export const COPILOT_TOKEN_ENV = 'COPILOT_GITHUB_TOKEN';

export function childProcessEnv<V extends string | undefined>(
  parent: Record<string, string | undefined>,
  overrides: Record<string, V> | undefined,
  options: { githubAuth?: boolean; copilotAuth?: boolean } = {},
): Record<string, string | V | undefined> {
  const merged = { ...parent, ...overrides };
  if (options.githubAuth) return merged;
  const stripped: Record<string, string | V | undefined> = withoutGitHubCredentials(merged);
  const copilotToken = parent[COPILOT_TOKEN_ENV];
  return options.copilotAuth && copilotToken ? { ...stripped, [COPILOT_TOKEN_ENV]: copilotToken } : stripped;
}

const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)/g;

const MIN_REDACTABLE_SECRET_LENGTH = 8;

export function redactGitHubCredentials(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  for (const [key, value] of Object.entries(env)) {
    if (!isGitHubCredentialEnvVar(key) || value === undefined || value.length < MIN_REDACTABLE_SECRET_LENGTH) continue;
    out = out.split(value).join('[redacted]');
  }
  return out.replace(GITHUB_TOKEN_PATTERN, '[redacted]');
}

export function redactExecError<E>(err: E, env: Record<string, string | undefined> = process.env): E {
  if (typeof err !== 'object' || err === null) return err;
  const e = err as Record<string, unknown>;
  for (const field of ['message', 'stack', 'cmd', 'stdout', 'stderr']) {
    const value = e[field];
    if (typeof value === 'string') e[field] = redactGitHubCredentials(value, env);
  }
  return err;
}
