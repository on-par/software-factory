export type GitHubPhase = 'plan' | 'build' | 'ship' | 'land';

export type GitHubPermissionLevel = 'read' | 'write';

export type GitHubAppPermissions = Partial<
  Record<
    'metadata' | 'contents' | 'issues' | 'pull_requests' | 'checks' | 'statuses' | 'actions',
    GitHubPermissionLevel
  >
>;

export interface PhaseGitHubScope {
  phase: GitHubPhase;
  permissions: GitHubAppPermissions;
  writesLimitedToIssues: boolean;
  mayMerge: boolean;
}

const SHIP_PERMISSIONS: GitHubAppPermissions = {
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  checks: 'read',
  statuses: 'read',
  actions: 'read',
};

export const PHASE_GITHUB_SCOPES: Readonly<Record<GitHubPhase, PhaseGitHubScope | null>> = {
  plan: {
    phase: 'plan',
    permissions: { metadata: 'read', contents: 'read', issues: 'write', pull_requests: 'read' },
    writesLimitedToIssues: true,
    mayMerge: false,
  },
  build: null,
  ship: { phase: 'ship', permissions: SHIP_PERMISSIONS, writesLimitedToIssues: false, mayMerge: false },
  land: { phase: 'land', permissions: SHIP_PERMISSIONS, writesLimitedToIssues: false, mayMerge: true },
};

export function scopeForPhase(phase: GitHubPhase): PhaseGitHubScope | null {
  return PHASE_GITHUB_SCOPES[phase] ?? null;
}

const MERGE_ROUTE = /\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/merge\/?(?:\?.*)?$/;
const MERGE_MUTATION = /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/;

export function isMergeRequest(method: string, url: string, body?: unknown): boolean {
  const verb = method.toUpperCase();
  if (verb === 'PUT') return MERGE_ROUTE.test(url);
  if (verb !== 'POST' || !/\/graphql\/?$/.test(url)) return false;
  const query = (body as { query?: unknown } | null | undefined)?.query;
  return typeof query === 'string' && MERGE_MUTATION.test(query);
}

export function permissionList(scope: PhaseGitHubScope): string {
  return Object.entries(scope.permissions)
    .map(([name, level]) => `${name}:${level}`)
    .join(', ');
}
