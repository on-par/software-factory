// src/utils/required-checks.ts — strict "every required check succeeded" verdict for a commit (#3186); #3195 adds an opt-in push-event fallback when no checks are required; #3206 adds a three-way classifier and the shared required-contexts lookup

import type { Octokit } from '@octokit/rest';

export interface RequiredChecksVerdict {
  green: boolean;
  reason: string;
  /** Set when green; what the verdict was based on. */
  basis?: string;
}

type PushWorkflowFailureLogger = (type: 'base_push_workflow_failed', msg: string) => void;
const observedPushWorkflowFailures = new Set<string>();

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

/** Required check contexts from branch protection plus rulesets, checked against the check runs on the exact SHA. Throws on unexpected API errors. */
export async function fetchRequiredChecksVerdict(
  octokit: Octokit,
  args: { owner: string; repo: string; branch: string; sha: string },
  opts?: { pushFallback?: boolean; checks?: readonly string[]; log?: PushWorkflowFailureLogger },
): Promise<RequiredChecksVerdict> {
  const { owner, repo, branch, sha } = args;
  const explicit = opts?.checks !== undefined;
  const required = explicit ? [...new Set(opts.checks)] : await fetchRequiredContexts(octokit, { owner, repo, branch });
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

  const hasNamedSelection = explicit || required.length > 0;
  const fallback = !hasNamedSelection && opts?.pushFallback === true;
  const shouldReadWorkflows = fallback || opts?.log !== undefined;
  let selected: RequiredChecksVerdict;
  if (explicit && required.length === 0) {
    selected = { green: false, reason: 'no code-health checks configured' };
  } else if (hasNamedSelection) {
    selected = evaluateRequiredChecks(required, runs);
  } else if (fallback) {
    selected = { green: false, reason: 'missing code-health checks from CI' };
  } else {
    selected = { green: false, reason: 'no required checks configured' };
  }

  if (!shouldReadWorkflows) return selected;

  let workflows: Array<{
    id: number;
    name?: string | null;
    status: string | null;
    conclusion: string | null;
    check_suite_id?: number;
  }>;
  try {
    const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      head_sha: sha,
      event: 'push',
      per_page: 100,
    });
    workflows = data.workflow_runs;
  } catch (err) {
    if (fallback) throw err;
    return selected;
  }

  const selectedSuites = new Set<number>();
  const ciSuites = new Set<number>();
  for (const workflow of workflows) {
    if (workflow.check_suite_id === undefined) continue;
    if (workflow.name === 'CI') ciSuites.add(workflow.check_suite_id);
    if (
      hasNamedSelection &&
      runs.some((run) => run.suiteId === workflow.check_suite_id && required.includes(run.name))
    ) {
      selectedSuites.add(workflow.check_suite_id);
    }
  }

  if (fallback) {
    const selectedRuns = runs.filter((run) => run.suiteId !== null && ciSuites.has(run.suiteId));
    selected =
      selectedRuns.length === 0
        ? { green: false, reason: 'missing code-health checks: no push CI check runs' }
        : evaluatePushChecks(selectedRuns);
  }

  if (opts?.log !== undefined) {
    for (const workflow of workflows) {
      const isSelected = fallback
        ? workflow.name === 'CI'
        : workflow.check_suite_id !== undefined && selectedSuites.has(workflow.check_suite_id);
      if (
        isSelected ||
        workflow.status !== 'completed' ||
        workflow.conclusion === null ||
        workflow.conclusion === 'success' ||
        workflow.conclusion === 'neutral' ||
        workflow.conclusion === 'skipped'
      ) {
        continue;
      }
      const workflowName = workflow.name ?? `workflow ${workflow.id}`;
      const key = `${owner}/${repo}:${sha}:${workflowName}`;
      if (observedPushWorkflowFailures.has(key)) continue;
      observedPushWorkflowFailures.add(key);
      try {
        opts.log(
          'base_push_workflow_failed',
          `${owner}/${repo} ${sha}: push workflow ${workflowName} concluded ${workflow.conclusion}`,
        );
      } catch {
        observedPushWorkflowFailures.delete(key);
      }
    }
  }
  return selected;
}
