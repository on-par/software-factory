// src/phases/ship.ts — SHIP phase: create/verify PR, mark ready for review

import { issueNumberOf, type WorkKey } from '../work/work-key.js';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { Octokit } from '@octokit/rest';

import type { ApprovalGate } from '../approvals/index.js';
import { type LifecycleBus, withLifecycle } from '../bus/index.js';
import type { EventKind } from '../events/kinds.js';
import { gatherEvidencePack } from '../reports/evidence-pack.js';
import { renderPrBody } from '../reports/pr-body.js';
import { computeDiffStat } from './ship-diff-stat.js';
import { lazyWalkthrough, type WalkthroughShipOpts } from './ship-walkthrough.js';
import { renderStackOrderLine, type StackPosition } from './stack-order.js';
import type { ReviewRouting } from '../review/routing.js';
import {
  type CommandRunner,
  checkRemoteIsAncestor,
  describePushFailure,
  pushAndVerifyRemoteHead,
  readRemoteBranchSha,
  shortDetail,
  verifyRemoteHead,
} from './ship-git.js';
import { commitLeftoverBuildOutput } from './ship-leftover.js';
import { markPrReadyWithRetry } from './ship-ready.js';
import { readRisk, readSpecBody } from './ship-spec.js';
import type { CheckSummary, CiFailureEvidence } from '../types/index.js';
import { collectCiFailureEvidence } from '../utils/ci-evidence.js';
import { DEFAULT_CI_DEADLINE_MS, type InfraRerunOutcome, watchChecksWithInfraRerun } from '../utils/ci-watch.js';
import { shellEscape } from '../utils/index.js';
import { GITHUB_ISSUE_SOURCE } from '../work/github-issue.js';
import type { WorkRequest } from '../work/index.js';

/** Ship opens PRs against, and watches required checks of, this branch. */
const SHIP_BASE_BRANCH = 'main';

const exec = promisify(execCb);

export interface ShipResult {
  ok: boolean;
  prNumber?: number;
  denied?: boolean;
  deniedReason?: string;
  reason?: string;
  ciOutcome?: InfraRerunOutcome;
  /** Bounded evidence for a CI-watch 'failure' (#2814). */
  ciFailure?: CiFailureEvidence;
  /** True when the branch's content had already landed on main (e.g. a retry after a
   *  squash merge) — nothing was pushed and no PR was created (#520). */
  alreadyDelivered?: boolean;
  /** The head SHA watched on a CI rework re-entry (#2816). */
  headSha?: string;
  /** Draft mode (#3449): mark-ready skipped; callers must not merge. */
  draft?: boolean;
  /** CI watch timed out before a verdict (#3569): the PR was left as draft. */
  ciPending?: boolean;
}

export async function shipPhase(opts: Parameters<typeof shipPhaseImpl>[0]): Promise<ShipResult> {
  return withLifecycle(
    {
      bus: opts.bus,
      phase: 'ship',
      laneId: opts.laneId,
      issueId: opts.issue,
      worktreePath: opts.worktree,
      log: opts.log,
    },
    () => shipPhaseImpl(opts),
    (r) => r.ok,
    (r) =>
      r.ok
        ? `ship complete${r.prNumber === undefined ? '' : ` (PR #${r.prNumber})`}`
        : `ship failed${(r.deniedReason ?? r.reason) === undefined ? '' : `: ${r.deniedReason ?? r.reason}`}`,
  );
}

async function shipPhaseImpl(opts: {
  issue: WorkKey;
  repo: string;
  worktree: string;
  branch: string;
  octokit: Octokit;
  watchCI?: boolean;
  /** Resolved pr.footer; undefined uses the default, empty string omits it. */
  footer?: string;
  /** Stop at the draft PR: skip mark-ready (#3449). */
  draft?: boolean;
  /** Post the evidence pack as a PR comment (pr.evidenceComment); default off. */
  evidenceComment?: boolean;
  log: (type: EventKind, msg: string) => void;
  run?: CommandRunner;
  /** Runs the gh rerun argv for the CI infra rescue (#2365); default runCommand. */
  rerun?: (argv: readonly string[]) => Promise<{ ok: boolean }>;
  approvalGate?: ApprovalGate;
  checkSummary?: CheckSummary;
  specPath?: string;
  eventsFile?: string;
  startedAt?: string;
  logsDir?: string;
  reworkRounds?: number;
  /** PR classifier decision (#1724), rendered into the evidence pack. */
  reviewRouting?: ReviewRouting;
  /** Model pins that were not honored (#2511), rendered into the evidence pack. */
  pinNotes?: string[];
  /** The run's resolved work request; when its kind is not 'github-issue', the PR
   *  title/body come from it instead of fetching the (nonexistent) issue (#507). */
  work?: Pick<WorkRequest, 'id' | 'kind' | 'title' | 'reference'>;
  /** The ADR-0147 slice this run ships; titles the PR `slice k/n` and only the final slice closes the issue. */
  slice?: { index: number; count: number };
  /** Stack-mode (ADR-0161) position: the PR opens on `stack.base` and its body names the stack order. Ignored for inline work. */
  stack?: StackPosition;
  /** PR base for a non-stack run started from another branch (#3764); default main. */
  baseBranch?: string;
  /** Lane id stamped onto emitted lifecycle events; defaults to `issue-<issue>` (#591). */
  laneId?: string;
  /** Lifecycle bus to emit onto; defaults to the process-wide `lifecycleBus` (#591). */
  bus?: LifecycleBus;
  /** origin/<branch> SHA recorded at worktree creation (#1868). When set, the new-PR push
   *  replaces that stale head under a lease on this SHA, and fails closed if the remote moved (#1869). */
  recordedRemoteSha?: string;
  /** SHIP re-entry after a CI rework round (#2816): same open PR, plain push, watch the pushed SHA. */
  reentry?: { prNumber: number; previousHeadSha?: string };
  /** CI watch deadline (#3569); default DEFAULT_CI_DEADLINE_MS. */
  ciDeadlineMs?: number;
  walkthrough?: WalkthroughShipOpts['walkthrough'];
}): Promise<ShipResult> {
  const {
    issue,
    repo,
    worktree,
    branch,
    octokit,
    watchCI = true,
    log,
    run = exec,
    rerun,
    approvalGate,
    checkSummary,
  } = opts;
  const [owner, repoName] = repo.split('/');
  const getWalkthrough = lazyWalkthrough(run, worktree, opts, log);

  let diffStat: string | undefined;

  if (approvalGate) {
    // Log a 'ship'-typed event before anything else so the TUI's activePhase
    // advances to SHIP first — otherwise a denial reports failedPhase as
    // whichever phase (CHECK/BUILD) last logged, which is misleading.
    log('ship', `Starting ship phase for ${branch}`);
    diffStat = await computeDiffStat(run, worktree);
    log(
      'approval_requested',
      `awaiting approval to ship ${branch}${checkSummary ? ` (checks: ${checkSummary.passes} pass, ${checkSummary.failures} fail, ${checkSummary.skips} skip)` : ''}`,
    );
    const response = await approvalGate({ issue: issueNumberOf(issue), branch, worktree, diffStat, checkSummary });
    if (!response.approved) {
      const reason = response.reason ?? 'denied';
      log('ship_denied', `ship denied for ${branch}: ${reason}`);
      return { ok: false, denied: true, deniedReason: reason };
    }
    log('approval_granted', `approval granted for ${branch}`);
  }

  // Check if a PR already exists (claude route may have created one)
  const openLookup = await findOpenPR(octokit, owner, repoName, branch);
  if (openLookup.status === 'error') {
    const reason = `could not determine whether an open PR exists for ${branch} (${openLookup.detail})`;
    log('ship', `${reason} — aborting before PR creation`);
    return { ok: false, reason };
  }
  let prNumber: number | undefined = openLookup.status === 'found' ? openLookup.prNumber : undefined;
  const reentry = opts.reentry;
  let watchRef = branch;
  let headSha: string | undefined;

  if (reentry) {
    if (prNumber !== reentry.prNumber) {
      const reason = `re-entry expected open PR #${reentry.prNumber} for ${branch} but found ${prNumber === undefined ? 'none' : `#${prNumber}`}`;
      log('ship', reason);
      return { ok: false, reason };
    }
    let localSha: string;
    try {
      localSha = (await run('git rev-parse HEAD', { cwd: worktree })).stdout.trim();
    } catch (err) {
      const reason = `could not read local HEAD on re-entry (${shortDetail(err)})`;
      log('ship', reason);
      return { ok: false, prNumber, reason };
    }
    if (localSha && localSha === reentry.previousHeadSha) {
      const reason = `CI rework produced no new commit on ${branch}`;
      log('ship', reason);
      return { ok: false, prNumber, ciOutcome: 'failure', reason, headSha: localSha };
    }
    try {
      await run(`git push origin ${shellEscape(branch)}`, { cwd: worktree });
    } catch (err) {
      const { kind, detail } = describePushFailure(err);
      const reason = `re-entry push of ${branch} failed (${kind}): ${detail}`;
      log('ship', reason);
      return { ok: false, prNumber, reason };
    }
    const remoteHead = await verifyRemoteHead(run, worktree, branch);
    if (remoteHead.status !== 'match') {
      const reason =
        remoteHead.status === 'mismatch'
          ? `remote head ${remoteHead.remoteSha} does not match local HEAD ${remoteHead.localSha} for ${branch} after re-entry push`
          : `could not verify the remote head for ${branch} after re-entry push (${remoteHead.detail})`;
      log('ship', reason);
      return { ok: false, prNumber, reason };
    }
    watchRef = remoteHead.remoteSha;
    headSha = remoteHead.remoteSha;
    log('ship', `re-entry pushed ${branch} @ ${headSha}`);
  } else if (prNumber) {
    // Rework commits made after BUILD's push must reach the open PR before evidence or ready (#1813).
    const current = await verifyRemoteHead(run, worktree, branch);
    if (current.status === 'match') {
      log(
        'ship',
        `remote head ${current.remoteSha} matches local HEAD ${current.localSha} for ${branch} — already in sync, not pushing`,
      );
    } else {
      if (current.status === 'mismatch') {
        const ancestry = await checkRemoteIsAncestor(run, worktree, current.remoteSha, current.localSha);
        if (ancestry.status !== 'ancestor') {
          const reason =
            ancestry.status === 'diverged'
              ? `origin/${branch} @ ${current.remoteSha} has diverged from local HEAD ${current.localSha} (remote has commits local HEAD lacks) on open PR #${prNumber} — not force-pushing`
              : `could not confirm origin/${branch} @ ${current.remoteSha} is an ancestor of local HEAD ${current.localSha} on open PR #${prNumber} (${ancestry.detail})`;
          log('ship', `${reason} — aborting before evidence`);
          return { ok: false, prNumber, reason };
        }
      }
      const pushed = await pushAndVerifyRemoteHead(run, worktree, branch, `git push -u origin ${shellEscape(branch)}`);
      if (pushed.status !== 'pushed') {
        const reason =
          pushed.status === 'push-failed'
            ? `push of ${branch} to open PR #${prNumber} failed (${pushed.kind}): ${pushed.detail}`
            : pushed.status === 'mismatch'
              ? `remote head ${pushed.remoteSha} does not match local HEAD ${pushed.localSha} for ${branch} after push to open PR #${prNumber}`
              : `could not verify the remote head for ${branch} after push to open PR #${prNumber} (${pushed.detail})`;
        log('ship', `${reason} — aborting before evidence`);
        return { ok: false, prNumber, reason };
      }
      log('ship', `remote head ${pushed.remoteSha} matches local HEAD ${pushed.localSha} for ${branch}`);
    }
  }

  if (!prNumber) {
    // Recovery decisions must compare against the *current* remote — a stale
    // remote-tracking ref makes already-delivered work look like recovery work (#520).
    try {
      await run('git fetch origin main', { cwd: worktree });
    } catch {
      log('ship', 'git fetch origin main failed — recovery may compare against a stale origin/main');
    }

    let recoveryState = await inspectRecoveryState(worktree, run);
    if (!recoveryState.clean) {
      const conflicts = conflictedPaths(recoveryState.statusLines);
      if (conflicts.length > 0) {
        // Committing an unmerged index would put conflict markers on the PR branch —
        // park with the concrete paths and leave the worktree for a human (#1172).
        const listed =
          conflicts.slice(0, 5).join(', ') + (conflicts.length > 5 ? ` (+${conflicts.length - 5} more)` : '');
        const reason = `worktree has merge conflicts in ${listed}`;
        log('ship', `not recovering ${branch}: ${reason} — worktree preserved`);
        return { ok: false, reason };
      }
      // CHECK verified this exact working tree, so the dirt IS the green artifact —
      // commit it and ship rather than parking verified work (#1164/#1172).
      const committed = await commitLeftoverBuildOutput({
        run,
        worktree,
        branch,
        issue,
        statusLines: recoveryState.statusLines,
        log,
      });
      if (!committed.ok) {
        log('ship', `not recovering ${branch}: ${committed.reason} — worktree preserved`);
        return { ok: false, reason: committed.reason };
      }
      recoveryState = await inspectRecoveryState(worktree, run);
      if (!recoveryState.clean) {
        const reason = 'worktree still dirty after committing leftover build output';
        log('ship', `not recovering ${branch}: ${reason} — worktree preserved`);
        return { ok: false, reason };
      }
    }
    if (recoveryState.landed || !recoveryState.ahead) {
      // The branch's content is already on main: identical trees (squash merge) or an
      // empty ahead-count (merge commit / fast-forward). That is delivery, not recovery.
      const mergedLookup = await findMergedPR(octokit, owner, repoName, branch);
      if (mergedLookup.status === 'error' && !recoveryState.landed) {
        const reason = `could not determine whether ${branch} was already merged (${mergedLookup.detail})`;
        log('ship', `not recovering ${branch}: ${reason}`);
        return { ok: false, reason };
      }
      const mergedPr = mergedLookup.status === 'found' ? mergedLookup.prNumber : undefined;
      if (mergedPr !== undefined || recoveryState.landed) {
        log(
          'ship',
          `not recovering ${branch}: already delivered${mergedPr !== undefined ? ` by merged PR #${mergedPr}` : ' (HEAD tree matches origin/main)'}`,
        );
        return { ok: true, prNumber: mergedPr, alreadyDelivered: true };
      }
      const reason = 'no commits ahead of origin/main';
      log('ship', `not recovering ${branch}: ${reason}`);
      return { ok: false, reason };
    }

    // Push branch. A rejected push means the remote head does not contain this run's
    // commits — opening a PR against it would advertise work that is not there, so the
    // ship fails closed here rather than continuing to PR creation (#734).
    let pushCmd = `git push -u origin ${shellEscape(branch)}`;
    const recorded = opts.recordedRemoteSha;
    let leased = false;
    if (recorded) {
      // A retry rebuilds the branch from origin/main, so an earlier run's push is stale. Replace it
      // only while the remote is still exactly what was recorded at worktree creation (#1869).
      const current = await readRemoteBranchSha(run, worktree, branch);
      if (current.status === 'unreadable') {
        const reason = `could not read origin/${branch} to check recorded SHA ${recorded} (${current.detail})`;
        log('ship', `${reason} — aborting before push`);
        return { ok: false, reason };
      }
      if (current.sha === null) {
        log('ship', `origin/${branch} recorded @ ${recorded} no longer exists — nothing to replace, plain push`);
      } else if (current.sha !== recorded) {
        const reason = `origin/${branch} moved since it was recorded: recorded ${recorded}, current ${current.sha}`;
        log('ship', `${reason} — aborting before push`);
        return { ok: false, reason };
      } else {
        pushCmd = `git push ${shellEscape(`--force-with-lease=${branch}:${recorded}`)} -u origin ${shellEscape(branch)}`;
        leased = true;
        log('ship', `replacing stale origin/${branch} @ ${recorded} with a leased push`);
      }
    }
    // A zero-exit push is not proof the remote branch actually carries this run's commits — a
    // concurrent push or an update that silently applied nothing leaves the remote head elsewhere,
    // and a PR opened against it advertises work that is not there (#735). Fail closed, like the
    // push-failure abort (#734).
    const pushed = await pushAndVerifyRemoteHead(run, worktree, branch, pushCmd);
    if (pushed.status === 'push-failed') {
      const pushReason = `git push failed (${pushed.kind}): ${pushed.detail}`;
      log('ship', `${pushReason} — aborting before PR creation`);
      if (leased) {
        return {
          ok: false,
          reason: `leased push of ${branch} over recorded ${recorded} was rejected (${pushed.kind})`,
        };
      }
      return { ok: false, reason: pushReason };
    }
    if (pushed.status === 'mismatch') {
      const reason = `remote head ${pushed.remoteSha} does not match local HEAD ${pushed.localSha} for ${branch}`;
      log('ship', `${reason} — aborting before PR creation`);
      return { ok: false, reason };
    }
    if (pushed.status === 'unreadable') {
      const reason = `could not verify the remote head for ${branch} (${pushed.detail}); local HEAD ${pushed.localSha ?? 'unknown'}`;
      log('ship', `${reason} — aborting before PR creation`);
      return { ok: false, reason };
    }
    log('ship', `remote head ${pushed.remoteSha} matches local HEAD ${pushed.localSha} for ${branch}`);

    const inlineWork = opts.work && opts.work.kind !== GITHUB_ISSUE_SOURCE ? opts.work : undefined;

    // Get title from issue (skipped for a non-github work source — no such issue exists)
    const title = inlineWork
      ? inlineWork.title
      : (await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issueNumberOf(issue) })).data.title;

    // Get diff stats (reuse the approval gate's diff stat when already computed)
    const stat = diffStat ?? (await computeDiffStat(run, worktree));

    const slice = inlineWork ? undefined : opts.slice;
    const stack = inlineWork ? undefined : opts.stack;
    const base = stack?.base ?? opts.baseBranch ?? SHIP_BASE_BRANCH;
    const finalSlice = !slice || slice.index >= slice.count;
    // The brief's path is local and often gitignored, so the PR names it by content digest only.
    const briefDigest = inlineWork?.reference?.externalId.slice(0, 12);
    const summaryLine = inlineWork
      ? `Implements a local brief${briefDigest ? ` (sha256 \`${briefDigest}\`)` : ''}.`
      : slice
        ? `Implements slice ${slice.index}/${slice.count} of #${issue}.`
        : `Implements #${issue}.`;
    const prTitle = inlineWork
      ? title
      : slice
        ? `${title} — slice ${slice.index}/${slice.count} (#${issue})`
        : `${title} (#${issue})`;

    // Create PR
    try {
      const { data: pr } = await octokit.rest.pulls.create({
        owner,
        repo: repoName,
        head: branch,
        base,
        title: prTitle,
        draft: true,
        body: renderPrBody({
          summaryLine,
          footer: opts.footer,
          stackOrder: stack ? renderStackOrderLine(stack) : undefined,
          specBody: await readSpecBody(opts.specPath),
          diffStat: stat,
          checkSummary,
          reworkRounds: opts.reworkRounds,
          risk: await readRisk(opts.specPath),
          walkthrough: await getWalkthrough(),
          closes: inlineWork || !finalSlice ? undefined : issue,
          partOf: !inlineWork && !finalSlice ? issue : undefined,
        }),
      });

      prNumber = pr.number;
      log('pr_opened', `opened PR #${prNumber} for committed work on ${branch} (base ${base})`);
    } catch (err) {
      if (!isPullAlreadyExistsError(err)) throw err;
      const existing = await findOpenPR(octokit, owner, repoName, branch);
      if (existing.status !== 'found') {
        const reason = `pulls.create reported an existing PR for ${branch} but re-querying did not find it (${existing.status === 'error' ? existing.detail : 'no open PR listed'})`;
        log('ship', `${reason} — aborting`);
        return { ok: false, reason };
      }
      prNumber = existing.prNumber;
      log('recovered', `PR #${prNumber} already existed for ${branch}; reusing it`);
    }
  }

  if (!prNumber) {
    const reason = `Could not create or find PR for ${branch}`;
    log('fail', reason);
    return { ok: false, reason };
  }

  if (!reentry && opts.evidenceComment)
    try {
      let checkedSha: string | undefined;
      try {
        checkedSha = (await run('git rev-parse HEAD', { cwd: worktree })).stdout.trim() || undefined;
      } catch {}
      const body = gatherEvidencePack({
        issue,
        checkSummary,
        reworkRounds: opts.reworkRounds,
        specPath: opts.specPath,
        eventsFile: opts.eventsFile,
        startedAt: opts.startedAt,
        logsDir: opts.logsDir,
        reviewRouting: opts.reviewRouting,
        pinNotes: opts.pinNotes,
        headSha: checkedSha,
        walkthrough: await getWalkthrough(),
      });
      await octokit.rest.issues.createComment({ owner, repo: repoName, issue_number: prNumber, body });
      log('evidence', `posted evidence pack to PR #${prNumber}`);
    } catch {}

  let ciOutcome: InfraRerunOutcome | undefined;
  const ciDeadlineMs = opts.ciDeadlineMs ?? DEFAULT_CI_DEADLINE_MS;

  // Watch CI (best-effort)
  if (watchCI) {
    log('ship', `Watching CI for PR #${prNumber}`);
    try {
      ciOutcome = await watchChecksWithInfraRerun({
        octokit,
        owner,
        repo: repoName,
        ref: watchRef,
        rerun,
        deadlineMs: ciDeadlineMs,
        probeNoCi: true,
        requiredChecks: { branch: SHIP_BASE_BRANCH },
        onProgress: ({ total, completed, pending, remainingMs, waitingFor }) =>
          log(
            'ship',
            waitingFor?.length
              ? `CI for PR #${prNumber}: waiting for required check${waitingFor.length > 1 ? 's' : ''} ${waitingFor.map((w) => `${w.name} (${w.state})`).join(', ')}, ${Math.ceil(remainingMs / 60_000)} min left`
              : `CI for PR #${prNumber}: ${pending} pending, ${completed}/${total} completed, ${Math.ceil(remainingMs / 60_000)} min left before the CI timeout`,
          ),
        onNoChecks: ({ sha, defaultBranch }) =>
          log(
            'ship',
            `no CI configured on ${repo} (no workflow files on ${sha} and no checks or statuses on recent ${defaultBranch} commits); skipping CI wait`,
          ),
        onRescued: ({ headSha, runIds }) =>
          log(
            'ci-rescued',
            `CI rescued for PR #${prNumber}: reran infra-failed run(s) ${runIds.join(', ')} on ${headSha.slice(0, 12)} once and the re-watch is green`,
          ),
        onRescueFailed: ({ headSha, runIds, outcome }) =>
          log(
            'ci-rescue-failed',
            `CI rescue failed for PR #${prNumber}: reran infra-failed run(s) ${runIds.join(', ')} on ${headSha.slice(0, 12)} once and the re-watch ended ${outcome}`,
          ),
      });
      if (ciOutcome === 'success') log('ship', `CI green for PR #${prNumber}`);
      else if (ciOutcome === 'failure') {
        const reason = `CI failed for PR #${prNumber}`;
        log('ship', reason);
        const ciFailure = await collectCiFailureEvidence({ octokit, owner, repo: repoName, ref: watchRef, prNumber });
        return { ok: false, prNumber, reason, ciOutcome, ciFailure, ...(headSha ? { headSha } : {}) };
      } else if (ciOutcome === 'infra-failure') {
        const reason = `CI failed again for infrastructure reasons for PR #${prNumber} after one rerun`;
        log('ship', reason);
        return { ok: false, prNumber, reason, ciOutcome };
      } else if (ciOutcome === 'timeout') {
        // Log type must stay 'ship': 'timeout' is a terminal event kind in the CLI.
        log(
          'ship',
          `CI pending for PR #${prNumber}: CI did not finish within ${ciDeadlineMs / 60_000} min; leaving PR as draft`,
        );
      }
    } catch {}
  }

  const ciPending = ciOutcome === 'timeout';

  // Mark ready for review (if draft). REST pulls.update ignores `draft`;
  // undrafting requires the markPullRequestReadyForReview GraphQL mutation.
  if (opts.draft || ciPending) {
    try {
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber });
      if (!pr.draft) log('ship', `PR #${prNumber} is already open and not a draft; draft mode leaves it as is`);
    } catch {}
  } else {
    const flip = await markPrReadyWithRetry(octokit, owner, repoName, prNumber);
    if (!flip.ok) {
      const reason = `could not mark PR #${prNumber} ready for review after one retry: ${flip.detail}`;
      log('warn', reason);
      return {
        ok: false,
        prNumber,
        reason,
        ...(ciOutcome === undefined ? {} : { ciOutcome }),
        ...(headSha ? { headSha } : {}),
      };
    }
  }

  const noChecks = ciOutcome === 'no-checks' ? ' (CI skipped: no checks found)' : '';
  const readyLabel = opts.draft || ciPending ? `left as draft${ciPending ? ' (CI pending)' : ''}` : 'ready for review';
  log('ready', `PR #${prNumber} ${readyLabel}${noChecks}`);
  return {
    ok: true,
    prNumber,
    ...(ciOutcome === undefined ? {} : { ciOutcome }),
    ...(headSha ? { headSha } : {}),
    ...(opts.draft || ciPending ? { draft: true } : {}),
    ...(ciPending ? { ciPending: true } : {}),
  };
}

export async function findOpenPR(octokit: Octokit, owner: string, repo: string, branch: string): Promise<PrLookup> {
  try {
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      head: `${owner}:${branch}`,
    });
    const prNumber = prs[0]?.number;
    return prNumber === undefined ? { status: 'absent' } : { status: 'found', prNumber };
  } catch (err) {
    return { status: 'error', detail: shortDetail(err) };
  }
}

export async function findMergedPR(octokit: Octokit, owner: string, repo: string, branch: string): Promise<PrLookup> {
  try {
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'closed',
      head: `${owner}:${branch}`,
    });
    const prNumber = prs.find((pr) => pr.merged_at != null)?.number;
    return prNumber === undefined ? { status: 'absent' } : { status: 'found', prNumber };
  } catch (err) {
    return { status: 'error', detail: shortDetail(err) };
  }
}

/** A `pulls.create` 422 whose message says the PR already exists — recoverable by re-querying,
 *  unlike every other 422 (e.g. "No commits between ..."), which still propagates (#641). */
export function isPullAlreadyExistsError(err: unknown): boolean {
  const e = err as {
    status?: number;
    message?: string;
    response?: { data?: { errors?: Array<{ message?: string }> } };
  } | null;
  if (e?.status !== 422) return false;
  const messages = [e.message ?? '', ...(e.response?.data?.errors ?? []).map((x) => x?.message ?? '')];
  return messages.some((m) => /already exists/i.test(m));
}

async function inspectRecoveryState(
  worktree: string,
  run: CommandRunner,
): Promise<{ clean: boolean; ahead: boolean; landed: boolean; statusLines: string[] }> {
  const [{ stdout: status }, { stdout: ahead }, landed] = await Promise.all([
    run('git status --porcelain', { cwd: worktree }),
    run('git rev-list --count origin/main..HEAD', { cwd: worktree }),
    // A squash merge leaves origin/main..HEAD nonzero forever even though the branch's
    // tree is byte-identical to main — exit 0 here is the reliable "already landed" signal.
    run('git diff --quiet origin/main..HEAD', { cwd: worktree }).then(
      () => true,
      () => false,
    ),
  ]);
  return {
    clean: status.trim() === '',
    ahead: Number.parseInt(ahead.trim(), 10) > 0,
    landed,
    // Porcelain's first two characters are positional XY columns — trim only the right edge.
    statusLines: status
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== ''),
  };
}

/** Paths of porcelain lines that are unmerged (conflict) entries: `U` in either XY column,
 *  or the both-added/both-deleted codes `AA`/`DD`. Untracked (`??`) and every ordinary code
 *  are not conflicts. */
function conflictedPaths(statusLines: string[]): string[] {
  return statusLines
    .filter((line) => {
      const xy = line.slice(0, 2);
      return xy.includes('U') || xy === 'AA' || xy === 'DD';
    })
    .map((line) => line.slice(3));
}

/** The result of asking GitHub whether a PR exists for a branch. `error` is never collapsed
 *  into `absent` — an unanswered lookup makes ship fail closed rather than open a duplicate
 *  PR (#641). */
export type PrLookup =
  { status: 'found'; prNumber: number } | { status: 'absent' } | { status: 'error'; detail: string };
