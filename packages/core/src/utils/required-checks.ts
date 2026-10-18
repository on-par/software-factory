// src/utils/required-checks.ts — strict "every required check succeeded" verdict for a commit (#3186)

import type { Octokit } from '@octokit/rest';

export interface RequiredChecksVerdict {
  green: boolean;
  reason: string;
}

interface CheckRunLike {
  name: string;
  status: string | null;
  conclusion: string | null;
}

/** Green only when every required context has a completed run with conclusion `success`; fails closed otherwise. */
export function evaluateRequiredChecks(
  required: readonly string[],
  runs: readonly CheckRunLike[],
): RequiredChecksVerdict {
  const contexts = [...new Set(required)];
  if (contexts.length === 0) return { green: false, reason: 'no required checks configured' };
  for (const ctx of contexts) {
    const matching = runs.filter((r) => r.name === ctx);
    if (matching.length === 0) return { green: false, reason: `missing ${ctx}` };
    for (const run of matching) {
      if (run.status !== 'completed') return { green: false, reason: `${ctx} pending` };
      if (run.conclusion !== 'success') return { green: false, reason: `${ctx} ${run.conclusion ?? 'incomplete'}` };
    }
  }
  return { green: true, reason: `all ${contexts.length} required checks succeeded` };
}

function httpStatus(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status;
}

/** Required check contexts from branch protection plus rulesets, checked against the check runs on the exact SHA. Throws on unexpected API errors. */
export async function fetchRequiredChecksVerdict(
  octokit: Octokit,
  args: { owner: string; repo: string; branch: string; sha: string },
): Promise<RequiredChecksVerdict> {
  const { owner, repo, branch, sha } = args;
  const required: string[] = [];
  try {
    const { data } = await octokit.rest.repos.getStatusChecksProtection({ owner, repo, branch });
    required.push(...(data.contexts ?? []), ...(data.checks ?? []).map((c) => c.context));
  } catch (err) {
    if (httpStatus(err) !== 404 && httpStatus(err) !== 403) throw err;
  }
  try {
    const { data } = await octokit.rest.repos.getBranchRules({ owner, repo, branch, per_page: 100 });
    for (const rule of data) {
      if (rule.type !== 'required_status_checks') continue;
      required.push(...(rule.parameters?.required_status_checks ?? []).map((c) => c.context));
    }
  } catch (err) {
    if (httpStatus(err) !== 404) throw err;
  }
  const { data: checks } = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: sha,
    per_page: 100,
    filter: 'latest',
  });
  const runs = checks.check_runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion }));
  return evaluateRequiredChecks(required, runs);
}
