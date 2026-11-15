import type { Octokit } from '@octokit/rest';

export interface RequiredChecksVerdict {
  green: boolean;
  state?: 'green' | 'pending' | 'failed';
  reason: string;
  basis?: string;
  noCodeHealthChecks?: true;
  missing?: string[];
}

interface CheckRunLike {
  name: string;
  status: string | null;
  conclusion: string | null;
}

const PASSING_HEAD_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

const passed = (r: CheckRunLike): boolean => PASSING_HEAD_CONCLUSIONS.has(r.conclusion ?? '');

export function evaluateRequiredChecks(
  required: readonly string[],
  runs: readonly CheckRunLike[],
): RequiredChecksVerdict {
  const contexts = [...new Set(required)];
  if (contexts.length === 0) return { green: false, reason: 'no required checks configured', noCodeHealthChecks: true };
  const failed = contexts.flatMap((ctx) =>
    runs.filter((r) => r.name === ctx && r.status === 'completed' && !passed(r)).map((r) => ({ ctx, run: r })),
  )[0];
  if (failed)
    return { green: false, state: 'failed', reason: `${failed.ctx} ${failed.run.conclusion ?? 'incomplete'}` };
  const missing: string[] = [];
  let incomplete = false;
  let firstReason: string | undefined;
  for (const ctx of contexts) {
    const matching = runs.filter((r) => r.name === ctx);
    if (matching.length === 0) {
      missing.push(ctx);
      firstReason ??= `missing ${ctx}`;
    } else if (matching.some((r) => r.status !== 'completed')) {
      incomplete = true;
      firstReason ??= `${ctx} pending`;
    }
  }
  if (incomplete && firstReason) return { green: false, state: 'pending', reason: firstReason };
  if (missing.length > 0) return { green: false, state: 'pending', reason: `missing ${missing[0]}`, missing };
  return {
    green: true,
    state: 'green',
    reason: `all ${contexts.length} required checks succeeded`,
    basis: `required checks: ${contexts.join(', ')}`,
  };
}

export function evaluatePushChecks(runs: readonly CheckRunLike[]): RequiredChecksVerdict {
  if (runs.length === 0) return { green: false, state: 'pending', reason: 'no push-triggered checks' };
  const failed = runs.find((r) => r.status === 'completed' && !passed(r));
  if (failed) return { green: false, state: 'failed', reason: `${failed.name} ${failed.conclusion ?? 'incomplete'}` };
  const pending = runs.find((r) => r.status !== 'completed');
  if (pending) return { green: false, state: 'pending', reason: `${pending.name} pending` };
  return {
    green: true,
    state: 'green',
    reason: `all ${runs.length} push-triggered checks succeeded`,
    basis: `push checks: ${[...new Set(runs.map((r) => r.name))].join(', ')}`,
  };
}

function httpStatus(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status;
}

export interface RequiredChecksState {
  state: 'green' | 'pending' | 'failed';
  missing: string[];
  pending: string[];
  failed: string[];
}

export function classifyRequiredChecks(
  required: readonly string[],
  runs: readonly CheckRunLike[],
): RequiredChecksState {
  const result: RequiredChecksState = { state: 'pending', missing: [], pending: [], failed: [] };
  for (const ctx of new Set(required)) {
    const matching = runs.filter((r) => r.name === ctx);
    if (matching.length === 0) result.missing.push(ctx);
    else if (matching.some((r) => r.status === 'completed' && !passed(r))) result.failed.push(ctx);
    else if (matching.some((r) => r.status !== 'completed')) result.pending.push(ctx);
  }
  if (new Set(required).size === 0) return result;
  if (result.failed.length > 0) result.state = 'failed';
  else if (result.missing.length + result.pending.length > 0) result.state = 'pending';
  else result.state = 'green';
  return result;
}

export function classifyHeadChecks(
  required: readonly string[],
  runs: readonly CheckRunLike[],
): RequiredChecksState & { basis: 'required' | 'all-on-head'; total: number } {
  if (new Set(required).size > 0)
    return { ...classifyRequiredChecks(required, runs), basis: 'required', total: runs.length };
  const result: RequiredChecksState = { state: 'pending', missing: [], pending: [], failed: [] };
  for (const run of runs) {
    if (run.status !== 'completed') result.pending.push(run.name);
    else if (!PASSING_HEAD_CONCLUSIONS.has(run.conclusion ?? '')) result.failed.push(run.name);
  }
  if (result.failed.length > 0) result.state = 'failed';
  else if (runs.length > 0 && result.pending.length === 0) result.state = 'green';
  return { ...result, basis: 'all-on-head', total: runs.length };
}

const warnedNoProtection = new Set<string>();

export function warnNoBranchProtectionOnce(repo: string, branch: string, warn: (msg: string) => void): boolean {
  if (warnedNoProtection.has(repo)) return false;
  warnedNoProtection.add(repo);
  warn(`no branch protection on ${repo}@${branch}; using all checks on head`);
  return true;
}

export async function fetchRequiredContexts(
  octokit: Octokit,
  args: { owner: string; repo: string; branch: string },
): Promise<string[]> {
  const { owner, repo, branch } = args;
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
    if (httpStatus(err) !== 404 && httpStatus(err) !== 403) throw err;
  }
  return [...new Set(required)];
}

export interface PushWorkflowFailure {
  workflow: string;
  conclusion: string;
  sha: string;
}

const CODE_HEALTH_WORKFLOW = 'ci';
const NON_FAILURE_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

export async function fetchRequiredChecksVerdict(
  octokit: Octokit,
  args: { owner: string; repo: string; branch: string; sha: string },
  opts?: {
    pushFallback?: boolean;
    checks?: readonly string[];
    onPushWorkflowFailed?: (failure: PushWorkflowFailure) => void;
  },
): Promise<RequiredChecksVerdict> {
  const { owner, repo, branch, sha } = args;
  const explicit = [...new Set(opts?.checks ?? [])];
  const set = explicit.length > 0 ? explicit : await fetchRequiredContexts(octokit, { owner, repo, branch });
  const { data: checks } = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: sha,
    per_page: 100,
    filter: 'latest',
  });
  const runs = checks.check_runs.map((r) => ({
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    suiteId: r.check_suite?.id ?? null,
  }));
  const report = opts?.onPushWorkflowFailed;
  const fallback = set.length === 0 && opts?.pushFallback === true;
  const workflowRuns =
    opts?.pushFallback && (set.length === 0 || report)
      ? (
          await octokit.rest.actions.listWorkflowRunsForRepo({
            owner,
            repo,
            head_sha: sha,
            event: 'push',
            per_page: 100,
          })
        ).data.workflow_runs
      : [];
  const isCi = (w: { name?: string | null }): boolean => (w.name ?? '').trim().toLowerCase() === CODE_HEALTH_WORKFLOW;
  const ciSuites = new Set<number>();
  for (const w of workflowRuns) if (isCi(w) && w.check_suite_id !== undefined) ciSuites.add(w.check_suite_id);

  let verdict: RequiredChecksVerdict;
  if (set.length > 0) {
    verdict = evaluateRequiredChecks(set, runs);
    if (verdict.green && explicit.length > 0) verdict = { ...verdict, basis: `base health checks: ${set.join(', ')}` };
  } else if (fallback) {
    if (ciSuites.size === 0) {
      const workflow = workflowRuns.find(isCi);
      if (workflow) {
        const failed = workflow.status === 'completed' && !PASSING_HEAD_CONCLUSIONS.has(workflow.conclusion ?? '');
        return {
          green: false,
          state: failed ? 'failed' : 'pending',
          reason: `CI ${failed ? (workflow.conclusion ?? 'incomplete') : 'pending'}`,
        };
      }
      return {
        green: false,
        reason:
          'no code-health checks: set baseHealth.checks in .factory/config.json, require status checks on main, or name the push workflow "CI"',
        noCodeHealthChecks: true,
      };
    }
    verdict = evaluatePushChecks(runs.filter((r) => r.suiteId !== null && ciSuites.has(r.suiteId)));
  } else {
    verdict = evaluateRequiredChecks([], runs);
  }

  if (report) {
    const setNames = new Set(set);
    const seen = new Set<string>();
    for (const w of workflowRuns) {
      if (w.status !== 'completed' || !w.conclusion || NON_FAILURE_CONCLUSIONS.has(w.conclusion)) continue;
      if (fallback && isCi(w)) continue;
      if (!fallback && runs.some((r) => r.suiteId === w.check_suite_id && setNames.has(r.name))) continue;
      const workflow = w.name ?? '(unnamed)';
      if (seen.has(workflow)) continue;
      seen.add(workflow);
      report({ workflow, conclusion: w.conclusion, sha });
    }
  }
  return verdict;
}
