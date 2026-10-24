// src/utils/required-checks.ts — strict "every required check succeeded" verdict for a commit (#3186); #3195 adds an opt-in push-event fallback when no checks are required; #3206 adds a three-way classifier and the shared required-contexts lookup; #3290 limits the verdict to code-health checks

import type { Octokit } from '@octokit/rest';

export interface RequiredChecksVerdict {
  green: boolean;
  reason: string;
  /** Set when green; what the verdict was based on. */
  basis?: string;
  /** Set when not green because nothing decides code health (no deciding set); a moved base can never turn green (#3620). */
  noCodeHealthChecks?: true;
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
  if (contexts.length === 0) return { green: false, reason: 'no required checks configured', noCodeHealthChecks: true };
  for (const ctx of contexts) {
    const matching = runs.filter((r) => r.name === ctx);
    if (matching.length === 0) return { green: false, reason: `missing ${ctx}` };
    for (const run of matching) {
      if (run.status !== 'completed') return { green: false, reason: `${ctx} pending` };
      if (run.conclusion !== 'success') return { green: false, reason: `${ctx} ${run.conclusion ?? 'incomplete'}` };
    }
  }
  return {
    green: true,
    reason: `all ${contexts.length} required checks succeeded`,
    basis: `required checks: ${contexts.join(', ')}`,
  };
}

/** Green only when there is at least one push-triggered check run and every one completed with `success` (#3195). */
export function evaluatePushChecks(runs: readonly CheckRunLike[]): RequiredChecksVerdict {
  if (runs.length === 0) return { green: false, reason: 'no push-triggered checks' };
  for (const run of runs) {
    if (run.status !== 'completed') return { green: false, reason: `${run.name} pending` };
    if (run.conclusion !== 'success') return { green: false, reason: `${run.name} ${run.conclusion ?? 'incomplete'}` };
  }
  return {
    green: true,
    reason: `all ${runs.length} push-triggered checks succeeded`,
    basis: `push checks: ${[...new Set(runs.map((r) => r.name))].join(', ')}`,
  };
}

function httpStatus(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status;
}

export interface RequiredChecksState {
  state: 'green' | 'pending' | 'failed';
  /** Required contexts with no run yet. */
  missing: string[];
  /** Required contexts with a run that is not completed. */
  pending: string[];
  /** Required contexts with a completed run whose conclusion is not `success`. */
  failed: string[];
}

/**
 * Three-way view of the required contexts: failed beats pending beats green. Green means what
 * `evaluateRequiredChecks(...).green` means. An empty list returns `pending`, so callers must check emptiness themselves.
 */
export function classifyRequiredChecks(
  required: readonly string[],
  runs: readonly CheckRunLike[],
): RequiredChecksState {
  const result: RequiredChecksState = { state: 'pending', missing: [], pending: [], failed: [] };
  for (const ctx of new Set(required)) {
    const matching = runs.filter((r) => r.name === ctx);
    if (matching.length === 0) result.missing.push(ctx);
    else if (matching.some((r) => r.status !== 'completed')) result.pending.push(ctx);
    else if (matching.some((r) => r.conclusion !== 'success')) result.failed.push(ctx);
  }
  if (new Set(required).size === 0) return result;
  if (result.failed.length > 0) result.state = 'failed';
  else if (result.missing.length + result.pending.length > 0) result.state = 'pending';
  else result.state = 'green';
  return result;
}

// Mirrors ci-watch's isPassingConclusion allow-list (ADR-0014); ci-watch imports this module, so it cannot be imported here.
const PASSING_HEAD_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * Verdict on a head commit (#3208). With required contexts it is classifyRequiredChecks. With none, every check run on the
 * head counts as required: zero runs or any incomplete run is pending, any non-passing completed run is failed, else green.
 */
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

/** Logs the no-branch-protection fallback warning the first time per repo in this process; returns whether it warned. */
export function warnNoBranchProtectionOnce(repo: string, branch: string, warn: (msg: string) => void): boolean {
  if (warnedNoProtection.has(repo)) return false;
  warnedNoProtection.add(repo);
  warn(`no branch protection on ${repo}@${branch}; using all checks on head`);
  return true;
}

/** Required check contexts from branch protection plus rulesets (deduped). Throws on unexpected API errors. */
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

/**
 * Code-health verdict for a commit (#3290). The deciding set is, in order: `opts.checks`, the branch-protection/ruleset
 * required contexts, then (with `pushFallback`) the check runs of the push workflow named `CI`. Other failed push
 * workflows are only reported through `onPushWorkflowFailed` and never change the verdict. Throws on unexpected API errors.
 */
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
