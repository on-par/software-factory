// src/phases/ship.ts — SHIP phase: create/verify PR, mark ready for review

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { Octokit } from '@octokit/rest';
import { formatAdrNumber } from '@on-par/adr-kit';
import { createFsReader } from '@on-par/repo-context';

import { applyAdrWritePlan, planAdrWrites, readAdrDrafts } from '../adr/write.js';
import type { ApprovalGate } from '../approvals/index.js';
import { type LifecycleBus, withLifecycle } from '../bus/index.js';
import type { EventKind } from '../events/kinds.js';
import { gatherEvidencePack } from '../reports/evidence-pack.js';
import type { CheckSummary } from '../types/index.js';
import { watchChecks } from '../utils/ci-watch.js';
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
  /** True when the branch's content had already landed on main (e.g. a retry after a
   *  squash merge) — nothing was pushed and no PR was created (#520). */
  alreadyDelivered?: boolean;
  /** True when the ADR commit could not be verified onto the remote branch, so the open PR
   *  does not carry the ADR this run recorded (#736). Always accompanies `ok: false`. */
  adrPushFailed?: boolean;
}

export async function shipPhase(opts: Parameters<typeof shipPhaseImpl>[0]): Promise<ShipResult> {
  return withLifecycle(
    { bus: opts.bus, phase: 'ship', laneId: opts.laneId, issueId: opts.issue, worktreePath: opts.worktree },
    () => shipPhaseImpl(opts),
    (r) => r.ok,
    (r) =>
      r.ok
        ? `ship complete${r.prNumber === undefined ? '' : ` (PR #${r.prNumber})`}`
        : `ship failed${r.deniedReason === undefined ? '' : `: ${r.deniedReason}`}`,
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
  today?: string;
  /** The run's resolved work request; when its kind is not 'github-issue', the PR
   *  title/body come from it instead of fetching the (nonexistent) issue (#507). */
  work?: Pick<WorkRequest, 'id' | 'kind' | 'title'>;
  /** Lane id stamped onto emitted lifecycle events; defaults to `issue-<issue>` (#591). */
  laneId?: string;
  /** Lifecycle bus to emit onto; defaults to the process-wide `lifecycleBus` (#591). */
  bus?: LifecycleBus;
}): Promise<ShipResult> {
  const { issue, repo, worktree, branch, octokit, watchCI = true, log, run = exec, approvalGate, checkSummary } = opts;
  const [owner, repoName] = repo.split('/');

  const adr = await materializeAdrDrafts({
    issue,
    repo,
    worktree,
    specPath: opts.specPath,
    run,
    log,
    today: opts.today ?? new Date().toISOString().slice(0, 10),
  });

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

  // The ADR commit exists in this branch's local history, so a push that does not reach the
  // remote leaves the open PR misrepresenting the branch and merges the recorded decision
  // away. Same verified-push rule as the main-branch push site (#733/#734/#735), applied
  // here per #736 — the site ADR-0028 deferred.
  if (prNumber && adr.committed) {
    const pushed = await pushAdrCommit({ run, worktree, branch, prNumber, log });
    if (!pushed) return { ok: false, prNumber, adrPushFailed: true };
  }

  if (!prNumber) {
    // Recovery decisions must compare against the *current* remote — a stale
    // remote-tracking ref makes already-delivered work look like recovery work (#520).
    try {
      await run('git fetch origin main', { cwd: worktree });
    } catch {
      log('ship', 'git fetch origin main failed — recovery may compare against a stale origin/main');
    }

    // A failed ADR commit leaves its files on disk uncommitted (see materializeAdrDrafts) —
    // never let that alone make the worktree look dirty and abort the whole ship.
    const recoveryState = await inspectRecoveryState(worktree, run, adr.committed ? [] : adr.paths);
    if (!recoveryState.clean) {
      log('ship', `not recovering ${branch}: worktree has uncommitted changes`);
      return { ok: false };
    }
    if (recoveryState.landed || !recoveryState.ahead) {
      // Empty ahead-counts are delivery only when GitHub still shows a merged PR
      // for this branch. An identical tree without that evidence is usually a no-op build.
      const mergedLookup = await findMergedPR(octokit, owner, repoName, branch);
      if (mergedLookup.status === 'error' && !recoveryState.landed) {
        log(
          'ship',
          `not recovering ${branch}: could not determine whether it was already merged (${mergedLookup.detail})`,
        );
        return { ok: false };
      }
      const mergedPr = mergedLookup.status === 'found' ? mergedLookup.prNumber : undefined;
      if (mergedPr !== undefined) {
        log(
          'ship',
          `not recovering ${branch}: already delivered by merged PR #${mergedPr}`,
        );
        return { ok: true, prNumber: mergedPr, alreadyDelivered: true };
      }
      log('ship', `not recovering ${branch}: no commits ahead of origin/main`);
      return { ok: false };
    }

    // Push branch. A rejected push means the remote head does not contain this run's
    // commits — opening a PR against it would advertise work that is not there, so the
    // ship fails closed here rather than continuing to PR creation (#734).
    try {
      await run(`git push -u origin ${shellEscape(branch)}`, { cwd: worktree });
    } catch (err) {
      const { kind, detail } = describePushFailure(err);
      log('ship', `git push failed (${kind}): ${detail} — aborting before PR creation`);
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

    const summaryLine = inlineWork
      ? `Implements local brief \`${inlineWork.id}\`. Built by the Software Factory (PLAN → BUILD → CHECK → SHIP).`
      : `Implements #${issue}. Built by the Software Factory (PLAN → BUILD → CHECK → SHIP).`;

    // Create PR
    try {
      const { data: pr } = await octokit.rest.pulls.create({
        owner,
        repo: repoName,
        head: branch,
        base: 'main',
        title: inlineWork ? title : `${title} (#${issue})`,
        body: `## Summary
${summaryLine}

## Changes
\`\`\`
${stat}
\`\`\`

## Verification
This PR passed independent verification by checker agents before shipping.${inlineWork ? '' : `\n\nCloses #${issue}`}`,
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
    });
    await octokit.rest.issues.createComment({ owner, repo: repoName, issue_number: prNumber, body });
    log('evidence', `posted evidence pack to PR #${prNumber}`);
  } catch {}

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

  // Watch CI (best-effort)
  if (watchCI) {
    log('ship', `Watching CI for PR #${prNumber}`);
    try {
      const outcome = await watchChecks({ octokit, owner, repo: repoName, ref: branch });
      if (outcome === 'success') log('ship', `CI green for PR #${prNumber}`);
      else if (outcome === 'failure') log('ship', `CI failed for PR #${prNumber}`);
      // outcome === 'timeout': no log, proceed to ready (unchanged best-effort behavior)
    } catch {}
  }

  log('ready', `PR #${prNumber} ready for review`);
  return { ok: true, prNumber };
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
  ignorePaths: string[] = [],
): Promise<{ clean: boolean; ahead: boolean; landed: boolean }> {
  const statusCommand =
    ignorePaths.length > 0
      ? `git status --porcelain -- . ${ignorePaths.map((p) => shellEscape(`:!${p}`)).join(' ')}`
      : 'git status --porcelain';
  const [{ stdout: status }, { stdout: ahead }, landed] = await Promise.all([
    run(statusCommand, { cwd: worktree }),
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
  };
}

/** The written path's own filename already carries the repo's detected number padding
 *  (e.g. '002-x.md' in a 3-digit-convention repo) — reuse it so the commit message and log
 *  never disagree with the file actually on disk, unlike formatAdrNumber's default width-4. */
function adrNumberLabel(write: { path: string; number: number }): string {
  const match = /^(\d+)-/.exec(write.path.split('/').pop() ?? '');
  return match ? match[1] : formatAdrNumber(write.number);
}

async function materializeAdrDrafts(o: {
  issue: number;
  repo: string;
  worktree: string;
  specPath?: string;
  run: CommandRunner;
  log: (type: EventKind, msg: string) => void;
  today: string;
}): Promise<{ committed: boolean; paths: string[] }> {
  if (!o.specPath) return { committed: false, paths: [] };
  const drafts = await readAdrDrafts(o.specPath);
  if (drafts.length === 0) return { committed: false, paths: [] };

  // A 'ship'-typed line first, for the same reason the approval block logs one: it is what
  // advances the TUI's activePhase to SHIP.
  o.log('ship', `materializing ${drafts.length} ADR draft(s) from the frozen plan`);

  const reader = createFsReader({
    root: o.worktree,
    onDegrade: (event) => {
      if (event.reason === 'not-found') return; // a repo with no docs/adr is normal
      o.log('adr_read_degraded', `adr read degraded: ${event.operation} ${event.path} (${event.reason})`);
    },
  });
  const plan = await planAdrWrites(reader, drafts, {
    date: o.today,
    issueRef: { text: `Issue #${o.issue}`, url: `https://github.com/${o.repo}/issues/${o.issue}` },
  });
  for (const r of plan.rejected) {
    o.log('adr_draft_rejected', `ADR draft "${r.title}" refused: ${r.errors.join('; ')}`);
  }
  for (const s of plan.skipped) {
    o.log('adr_draft_skipped', `ADR draft "${s.title}" skipped (${s.reason})`);
  }
  if (plan.indexSkipped) {
    o.log('adr_index_skipped', `ADR index not updated in ${plan.dir} (${plan.indexSkipped})`);
  }
  if (plan.writes.length === 0) return { committed: false, paths: [] };

  const written = await applyAdrWritePlan(plan, { root: o.worktree });
  const labels = plan.writes.map((w) => `ADR-${adrNumberLabel(w)} ${w.title}`).join(', ');
  try {
    await o.run(`git add ${written.map(shellEscape).join(' ')}`, { cwd: o.worktree });
    await o.run(`git commit -m ${shellEscape(`docs(adr): record ${labels} (#${o.issue})`)}`, { cwd: o.worktree });
  } catch {
    // Nothing staged (an identical re-ship) or git refused — the files are on disk either
    // way; never fail a ship over documentation. The caller excludes `paths` from its own
    // dirty-worktree check so this alone never aborts the rest of shipPhase.
    o.log('adr_commit_skipped', `could not commit ${plan.dir} — the ADR may not reach the PR`);
    return { committed: false, paths: written };
  }
  o.log('adr_written', `recorded ${plan.writes.length} ADR(s) in ${plan.dir}: ${labels}`);
  return { committed: true, paths: written };
}

/**
 * Push the ADR commit onto an already-open PR's branch, under the same verified-push rule the
 * main-branch push site uses: git's own failure text is logged (#733), and a zero-exit push is
 * not trusted until the remote head is confirmed to match local HEAD (#735). Returns false when
 * the ADR commit is not provably on the remote, in which case the caller fails the ship (#736).
 */
async function pushAdrCommit(o: {
  run: CommandRunner;
  worktree: string;
  branch: string;
  prNumber: number;
  log: (type: EventKind, msg: string) => void;
}): Promise<boolean> {
  try {
    await o.run(`git push -u origin ${shellEscape(o.branch)}`, { cwd: o.worktree });
  } catch (err) {
    const { kind, detail } = describePushFailure(err);
    o.log(
      'adr_push_failed',
      `pushing the ADR commit for PR #${o.prNumber} failed (${kind}): ${detail} — aborting the ship`,
    );
    return false;
  }

  const remoteHead = await verifyRemoteHead(o.run, o.worktree, o.branch);
  if (remoteHead.status === 'mismatch') {
    o.log(
      'adr_push_failed',
      `remote head ${remoteHead.remoteSha} does not match local HEAD ${remoteHead.localSha} after the ADR push for ${o.branch} — aborting the ship`,
    );
    return false;
  }
  if (remoteHead.status === 'unreadable') {
    o.log(
      'adr_push_failed',
      `could not verify the remote head after the ADR push for ${o.branch} (${remoteHead.detail}); local HEAD ${remoteHead.localSha ?? 'unknown'} — aborting the ship`,
    );
    return false;
  }
  o.log(
    'ship',
    `remote head ${remoteHead.remoteSha} matches local HEAD ${remoteHead.localSha} after the ADR push for ${o.branch}`,
  );
  return true;
}

/** Why a `git push` was refused, as far as git's own stderr says (#733). */
type PushFailureKind = 'non-fast-forward' | 'network' | 'unknown';

/** Bound on the failure text copied into one NDJSON event row. */
const MAX_PUSH_ERROR_DETAIL = 400;

const NON_FAST_FORWARD_MARKERS = ['non-fast-forward', '! [rejected]', 'fetch first', 'updates were rejected'];

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
