// src/phases/ship.ts — SHIP phase: create/verify PR, mark ready for review

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { Octokit } from '@octokit/rest';

import type { ApprovalGate } from '../approvals/index.js';
import { type LifecycleBus, withLifecycle } from '../bus/index.js';
import type { EventKind } from '../events/kinds.js';
import { gatherEvidencePack } from '../reports/evidence-pack.js';
import { renderPrBody } from '../reports/pr-body.js';
import type { ReviewRouting } from '../review/routing.js';
import { readSpec } from '../spec/index.js';
import type { CheckSummary } from '../types/index.js';
import { type CiOutcome, watchChecks } from '../utils/ci-watch.js';
import { shellEscape } from '../utils/index.js';
import { GITHUB_ISSUE_SOURCE } from '../work/github-issue.js';
import type { WorkRequest } from '../work/index.js';

const exec = promisify(execCb);
type CommandRunner = (command: string, options?: { cwd?: string; timeout?: number }) => Promise<{ stdout: string }>;

export interface ShipResult {
  ok: boolean;
  prNumber?: number;
  denied?: boolean;
  deniedReason?: string;
  reason?: string;
  ciOutcome?: CiOutcome;
  /** True when the branch's content had already landed on main (e.g. a retry after a
   *  squash merge) — nothing was pushed and no PR was created (#520). */
  alreadyDelivered?: boolean;
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
  issue: number;
  repo: string;
  worktree: string;
  branch: string;
  octokit: Octokit;
  watchCI?: boolean;
  log: (type: EventKind, msg: string) => void;
  run?: CommandRunner;
  approvalGate?: ApprovalGate;
  checkSummary?: CheckSummary;
  specPath?: string;
  eventsFile?: string;
  startedAt?: string;
  logsDir?: string;
  reworkRounds?: number;
  /** PR classifier decision (#1724), rendered into the evidence pack. */
  reviewRouting?: ReviewRouting;
  /** The run's resolved work request; when its kind is not 'github-issue', the PR
   *  title/body come from it instead of fetching the (nonexistent) issue (#507). */
  work?: Pick<WorkRequest, 'id' | 'kind' | 'title'>;
  /** The ADR-0147 slice this run ships; titles the PR `slice k/n` and only the final slice closes the issue. */
  slice?: { index: number; count: number };
  /** Lane id stamped onto emitted lifecycle events; defaults to `issue-<issue>` (#591). */
  laneId?: string;
  /** Lifecycle bus to emit onto; defaults to the process-wide `lifecycleBus` (#591). */
  bus?: LifecycleBus;
  /** origin/<branch> SHA recorded at worktree creation (#1868). When set, the new-PR push
   *  replaces that stale head under a lease on this SHA, and fails closed if the remote moved (#1869). */
  recordedRemoteSha?: string;
}): Promise<ShipResult> {
  const { issue, repo, worktree, branch, octokit, watchCI = true, log, run = exec, approvalGate, checkSummary } = opts;
  const [owner, repoName] = repo.split('/');

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
    const response = await approvalGate({ issue, branch, worktree, diffStat, checkSummary });
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
    log(
      'ship',
      `could not determine whether an open PR exists for ${branch} (${openLookup.detail}) — aborting before PR creation`,
    );
    return { ok: false };
  }
  let prNumber: number | undefined = openLookup.status === 'found' ? openLookup.prNumber : undefined;

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
        log(
          'ship',
          `not recovering ${branch}: could not determine whether it was already merged (${mergedLookup.detail})`,
        );
        return { ok: false };
      }
      const mergedPr = mergedLookup.status === 'found' ? mergedLookup.prNumber : undefined;
      if (mergedPr !== undefined || recoveryState.landed) {
        log(
          'ship',
          `not recovering ${branch}: already delivered${mergedPr !== undefined ? ` by merged PR #${mergedPr}` : ' (HEAD tree matches origin/main)'}`,
        );
        return { ok: true, prNumber: mergedPr, alreadyDelivered: true };
      }
      log('ship', `not recovering ${branch}: no commits ahead of origin/main`);
      return { ok: false };
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
    try {
      await run(pushCmd, { cwd: worktree });
    } catch (err) {
      const { kind, detail } = describePushFailure(err);
      log('ship', `git push failed (${kind}): ${detail} — aborting before PR creation`);
      if (leased) {
        return { ok: false, reason: `leased push of ${branch} over recorded ${recorded} was rejected (${kind})` };
      }
      return { ok: false };
    }

    // A zero-exit push is not proof the remote branch actually carries this run's commits — a
    // concurrent push or an update that silently applied nothing leaves the remote head elsewhere,
    // and a PR opened against it advertises work that is not there (#735). Fail closed, like the
    // push-failure abort above (#734).
    const remoteHead = await verifyRemoteHead(run, worktree, branch);
    if (remoteHead.status === 'mismatch') {
      log(
        'ship',
        `remote head ${remoteHead.remoteSha} does not match local HEAD ${remoteHead.localSha} for ${branch} — aborting before PR creation`,
      );
      return { ok: false };
    }
    if (remoteHead.status === 'unreadable') {
      log(
        'ship',
        `could not verify the remote head for ${branch} (${remoteHead.detail}); local HEAD ${remoteHead.localSha ?? 'unknown'} — aborting before PR creation`,
      );
      return { ok: false };
    }
    log('ship', `remote head ${remoteHead.remoteSha} matches local HEAD ${remoteHead.localSha} for ${branch}`);

    const inlineWork = opts.work && opts.work.kind !== GITHUB_ISSUE_SOURCE ? opts.work : undefined;

    // Get title from issue (skipped for a non-github work source — no such issue exists)
    const title = inlineWork
      ? inlineWork.title
      : (await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue })).data.title;

    // Get diff stats (reuse the approval gate's diff stat when already computed)
    const stat = diffStat ?? (await computeDiffStat(run, worktree));

    const slice = inlineWork ? undefined : opts.slice;
    const finalSlice = !slice || slice.index >= slice.count;
    const summaryLine = inlineWork
      ? `Implements local brief \`${inlineWork.id}\`.`
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
        base: 'main',
        title: prTitle,
        draft: true,
        body: renderPrBody({
          summaryLine,
          specBody: await readSpecBody(opts.specPath),
          diffStat: stat,
          checkSummary,
          closes: inlineWork || !finalSlice ? undefined : issue,
          partOf: !inlineWork && !finalSlice ? issue : undefined,
        }),
      });

      prNumber = pr.number;
      log('recovered', `opened PR #${prNumber} for committed work on ${branch}`);
    } catch (err) {
      if (!isPullAlreadyExistsError(err)) throw err;
      const existing = await findOpenPR(octokit, owner, repoName, branch);
      if (existing.status !== 'found') {
        log(
          'ship',
          `pulls.create reported an existing PR for ${branch} but re-querying did not find it (${existing.status === 'error' ? existing.detail : 'no open PR listed'}) — aborting`,
        );
        return { ok: false };
      }
      prNumber = existing.prNumber;
      log('recovered', `PR #${prNumber} already existed for ${branch}; reusing it`);
    }
  }

  if (!prNumber) {
    log('fail', `Could not create or find PR for ${branch}`);
    return { ok: false };
  }

  try {
    const body = gatherEvidencePack({
      issue,
      checkSummary,
      reworkRounds: opts.reworkRounds,
      specPath: opts.specPath,
      eventsFile: opts.eventsFile,
      startedAt: opts.startedAt,
      logsDir: opts.logsDir,
      reviewRouting: opts.reviewRouting,
    });
    await octokit.rest.issues.createComment({ owner, repo: repoName, issue_number: prNumber, body });
    log('evidence', `posted evidence pack to PR #${prNumber}`);
  } catch {}

  let ciOutcome: CiOutcome | undefined;

  // Watch CI (best-effort)
  if (watchCI) {
    log('ship', `Watching CI for PR #${prNumber}`);
    try {
      ciOutcome = await watchChecks({ octokit, owner, repo: repoName, ref: branch });
      if (ciOutcome === 'success') log('ship', `CI green for PR #${prNumber}`);
      else if (ciOutcome === 'failure') {
        const reason = `CI failed for PR #${prNumber}`;
        log('ship', reason);
        return { ok: false, prNumber, reason, ciOutcome };
      }
      // outcome === 'timeout': no log, proceed to ready (unchanged best-effort behavior)
    } catch {}
  }

  // Mark ready for review (if draft). REST pulls.update ignores `draft`;
  // undrafting requires the markPullRequestReadyForReview GraphQL mutation.
  try {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber });
    if (pr.draft) {
      await octokit.graphql(
        `mutation MarkPullRequestReady($id: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $id }) {
            pullRequest { isDraft }
          }
        }`,
        { id: pr.node_id },
      );
    }
  } catch {}

  log('ready', `PR #${prNumber} ready for review`);
  return ciOutcome === undefined ? { ok: true, prNumber } : { ok: true, prNumber, ciOutcome };
}

/** The frozen spec body for the PR description; undefined when there is no readable spec. */
async function readSpecBody(specPath: string | undefined): Promise<string | undefined> {
  if (!specPath) return undefined;
  try {
    return (await readSpec(specPath)).body;
  } catch {
    return undefined;
  }
}

async function computeDiffStat(run: CommandRunner, worktree: string): Promise<string> {
  try {
    const { stdout } = await run('git diff --stat origin/main...HEAD', { cwd: worktree });
    return stdout.split('\n').slice(-20).join('\n');
  } catch {
    return '';
  }
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
function isPullAlreadyExistsError(err: unknown): boolean {
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

/**
 * Commit the dirt a build agent left after a green CHECK onto the ship-it branch — the working
 * tree is byte-for-byte what the checkers verified, so committing it is what ships the green
 * artifact instead of parking it (#1164/#1172).
 */
async function commitLeftoverBuildOutput(o: {
  run: CommandRunner;
  worktree: string;
  branch: string;
  issue: number;
  statusLines: string[];
  log: (type: EventKind, msg: string) => void;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await o.run('git add -A', { cwd: o.worktree });
    await o.run(`git commit -m ${shellEscape(`chore(ship): commit build output left after check (#${o.issue})`)}`, {
      cwd: o.worktree,
    });
  } catch (err) {
    return { ok: false, reason: `could not commit leftover build output: ${shortDetail(err)}` };
  }
  o.log('ship', `committed ${o.statusLines.length} uncommitted path(s) left after check on ${o.branch}`);
  return { ok: true };
}

/** Why a `git push` was refused, as far as git's own stderr says (#733). */
type PushFailureKind = 'non-fast-forward' | 'network' | 'unknown';

/** Bound on the failure text copied into one NDJSON event row. */
const MAX_PUSH_ERROR_DETAIL = 400;

const NON_FAST_FORWARD_MARKERS = [
  'non-fast-forward',
  '! [rejected]',
  'fetch first',
  'updates were rejected',
  'stale info',
];

const NETWORK_MARKERS = [
  'could not resolve host',
  'failed to connect',
  'connection timed out',
  'connection refused',
  'network is unreachable',
  'operation timed out',
  'the remote end hung up unexpectedly',
];

function classifyPushFailure(text: string): PushFailureKind {
  const t = text.toLowerCase();
  if (NON_FAST_FORWARD_MARKERS.some((m) => t.includes(m))) return 'non-fast-forward';
  if (NETWORK_MARKERS.some((m) => t.includes(m))) return 'network';
  return 'unknown';
}

/**
 * The real reason a push failed, from git's own stderr when the runner exposes it
 * (node's promisified `exec` rejection carries `stderr`), else the Error message, else the
 * value's string form. Flattened to one line and bounded so a single event row stays
 * greppable in `.factory/events.ndjson`.
 */
function describePushFailure(err: unknown): { kind: PushFailureKind; detail: string } {
  const raw = (err as { stderr?: unknown } | null | undefined)?.stderr;
  const stderr = typeof raw === 'string' ? raw : '';
  const text = stderr.trim() || (err instanceof Error ? err.message : String(err));
  const detail = text.replace(/\s+/g, ' ').trim().slice(0, MAX_PUSH_ERROR_DETAIL);
  return { kind: classifyPushFailure(detail), detail: detail || 'no error output' };
}

/** Bound on the ls-remote failure text copied into one NDJSON event row (#735). */
const MAX_REMOTE_HEAD_DETAIL = 200;

/** The result of comparing the pushed branch's remote head against local HEAD (#735). */
type RemoteHeadCheck =
  | { status: 'match'; localSha: string; remoteSha: string }
  | { status: 'mismatch'; localSha: string; remoteSha: string }
  | { status: 'unreadable'; localSha?: string; remoteSha?: string; detail: string };

/** The result of asking GitHub whether a PR exists for a branch. `error` is never collapsed
 *  into `absent` — an unanswered lookup makes ship fail closed rather than open a duplicate
 *  PR (#641). */
export type PrLookup =
  { status: 'found'; prNumber: number } | { status: 'absent' } | { status: 'error'; detail: string };

/** Same flatten-and-bound shaping as {@link describePushFailure}, kept separate so that
 *  function's asserted output never changes. */
function shortDetail(err: unknown): string {
  const raw = (err as { stderr?: unknown } | null | undefined)?.stderr;
  const stderr = typeof raw === 'string' ? raw : '';
  const text = stderr.trim() || (err instanceof Error ? err.message : String(err));
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_REMOTE_HEAD_DETAIL) || 'no error output';
}

/** The SHA on the `refs/heads/<branch>` line of `git ls-remote` output. `--heads origin <branch>`
 *  is a suffix pattern, so it can list more than one ref — match the ref name exactly rather than
 *  trusting the first line. */
function parseRemoteHeadSha(stdout: string, branch: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === `refs/heads/${branch}` && sha) return sha;
  }
  return undefined;
}

/** origin/<branch>'s current SHA, `null` when the branch is absent, or the failure detail (#1869). */
async function readRemoteBranchSha(
  run: CommandRunner,
  worktree: string,
  branch: string,
): Promise<{ status: 'ok'; sha: string | null } | { status: 'unreadable'; detail: string }> {
  try {
    const { stdout } = await run(`git ls-remote --heads origin ${shellEscape(branch)}`, { cwd: worktree });
    return { status: 'ok', sha: parseRemoteHeadSha(stdout, branch) ?? null };
  } catch (err) {
    return { status: 'unreadable', detail: shortDetail(err) };
  }
}

/**
 * A zero-exit push is not proof the remote branch actually carries this run's commits — a
 * concurrent push or an update that silently applied nothing leaves the remote head elsewhere,
 * and a PR opened against it would advertise work that is not there (#735).
 */
async function verifyRemoteHead(run: CommandRunner, worktree: string, branch: string): Promise<RemoteHeadCheck> {
  let localSha: string | undefined;
  try {
    const { stdout } = await run('git rev-parse HEAD', { cwd: worktree });
    localSha = stdout.trim();
  } catch (err) {
    return { status: 'unreadable', detail: shortDetail(err) };
  }
  if (!localSha) return { status: 'unreadable', detail: 'git rev-parse HEAD produced no SHA' };

  let listing: string;
  try {
    const { stdout } = await run(`git ls-remote --heads origin ${shellEscape(branch)}`, { cwd: worktree });
    listing = stdout;
  } catch (err) {
    return { status: 'unreadable', localSha, detail: shortDetail(err) };
  }

  const remoteSha = parseRemoteHeadSha(listing, branch);
  if (!remoteSha) return { status: 'unreadable', localSha, detail: `no refs/heads/${branch} on origin` };
  return remoteSha === localSha
    ? { status: 'match', localSha, remoteSha }
    : { status: 'mismatch', localSha, remoteSha };
}
