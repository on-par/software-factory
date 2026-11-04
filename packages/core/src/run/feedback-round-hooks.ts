// packages/core/src/run/feedback-round-hooks.ts — runIssue's two hooks for a feedback round: prepare before PLAN, publish after SHIP (#3910)
import { readFileSync } from 'node:fs';

import { createOctokitCollaboratorPermissionClient, isTrustedApprover } from '../queue/approval.js';
import { defaultExecFn } from '../utils/exec.js';
import { createOctokitFeedbackRoundGitHub } from './feedback-github.js';
import { prepareFeedbackRound, publishFeedbackRound, type FeedbackRoundPlan } from './feedback-round.js';
import type { BuildRoute, RunOutcome } from './outcome.js';
import type { RunLogFn } from './attribution.js';
import type { RunPorts, RunRequest } from './run-issue.js';

type HookRequest = Pick<
  RunRequest,
  'feedbackRound' | 'resumeFrom' | 'repo' | 'specPath' | 'work' | 'timeouts' | 'trustedApprovers'
>;
type HookPorts = Pick<RunPorts, 'octokit' | 'router' | 'workspace' | 'gitExec'>;
type HookLog = RunLogFn;

const githubFor = (request: Pick<RunRequest, 'repo'>, ports: Pick<RunPorts, 'octokit'>) => {
  const [owner = '', name = ''] = request.repo.split('/');
  return createOctokitFeedbackRoundGitHub(ports.octokit, owner, name);
};

function readSpec(request: Pick<RunRequest, 'specPath' | 'work'>): string {
  try {
    return readFileSync(request.specPath, 'utf8');
  } catch {
    return request.work.brief;
  }
}

/** Reads and triages the PR's unhandled trusted feedback; undefined when this run is not a fresh feedback round. */
export async function prepareFeedbackForRun(
  request: HookRequest,
  ports: HookPorts,
  log: HookLog,
): Promise<FeedbackRoundPlan | undefined> {
  if (!request.feedbackRound || request.resumeFrom) return undefined;
  const [owner = '', name = ''] = request.repo.split('/');
  const client = createOctokitCollaboratorPermissionClient(ports.octokit);
  const plan = await prepareFeedbackRound({
    github: githubFor(request, ports),
    target: request.feedbackRound,
    spec: readSpec(request),
    isTrusted: (login) =>
      isTrustedApprover(login, { owner, repo: name, trustedApprovers: request.trustedApprovers, client }),
    run: async (prompt) => {
      const res = await ports.router.run('feedback_triage', prompt, {
        worktree: ports.workspace.path,
        timeoutSeconds: request.timeouts.plan,
      });
      return { model: res.model, output: res.output, cost: 0 };
    },
    log,
  });
  if (plan.items.length === 0) log('feedback_round_triaged', `PR #${plan.prNumber}: no unhandled trusted feedback`);
  return plan;
}

/** The actionable feedback, appended to PLAN's previous-attempt note on a re-plan. */
export function feedbackReplanNote(previous: string, plan: FeedbackRoundPlan | undefined): string {
  if (!plan?.replan) return previous;
  const details = plan.summary?.results[0]?.details ?? '';
  return [previous, '## Review feedback that changes scope', details].filter((s) => s !== '').join('\n\n');
}

function section(spec: string, heading: RegExp): string {
  const lines = spec.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && heading.test(l));
  if (start < 0) return '';
  const level = /^#+/.exec(lines[start] ?? '')?.[0].length ?? 2;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = /^(#+)\s/.exec(l);
    return m !== null && (m[1]?.length ?? 7) <= level;
  });
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n').trim();
}

/** The new spec's goal and acceptance sections, for the PR body's revised-spec block. */
export function revisedSpecSummary(specPath: string): string | undefined {
  let spec: string;
  try {
    spec = readFileSync(specPath, 'utf8');
  } catch {
    return undefined;
  }
  const text = [section(spec, /goal/i), section(spec, /acceptance/i)].filter((s) => s !== '').join('\n\n');
  return text === '' ? undefined : text;
}

/** Answers every item of the round; GitHub failures warn inside publishFeedbackRound and never fail the run. */
export async function publishFeedbackForRun(
  request: Pick<RunRequest, 'repo' | 'specPath'>,
  ports: Pick<RunPorts, 'octokit' | 'workspace' | 'gitExec'>,
  plan: FeedbackRoundPlan | undefined,
  headSha: string | undefined,
  log: HookLog,
): Promise<void> {
  if (!plan || plan.items.length === 0) return;
  let sha = headSha;
  if (sha === undefined && plan.summary !== undefined) {
    try {
      const run = ports.gitExec ?? defaultExecFn;
      sha = (await run('git rev-parse HEAD', { cwd: ports.workspace.path })).stdout.trim() || undefined;
    } catch {
      sha = undefined;
    }
  }
  const summary = plan.replan ? revisedSpecSummary(request.specPath) : undefined;
  await publishFeedbackRound({
    github: githubFor(request, ports),
    plan,
    repo: request.repo,
    headSha: sha,
    ...(summary === undefined ? {} : { revisedSpecSummary: summary }),
    log,
  });
}

/** With nothing actionable the round only answers its items; the run then ends without CHECK or SHIP. */
export async function idleFeedbackRound(
  plan: FeedbackRoundPlan | undefined,
  request: Pick<RunRequest, 'repo' | 'specPath' | 'branch'>,
  ports: Pick<RunPorts, 'octokit' | 'workspace' | 'gitExec'>,
  route: BuildRoute | undefined,
  log: HookLog,
): Promise<RunOutcome | undefined> {
  if (!plan || plan.summary !== undefined) return undefined;
  await publishFeedbackForRun(request, ports, plan, undefined, log);
  return { state: 'ready', route: route ?? 'claude', branch: request.branch, reworkRounds: 0, prNumber: plan.prNumber };
}
