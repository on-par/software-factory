// src/run/state.ts — The persisted IssueRunState record (#972). One JSON file per
// issue under getFactoryPaths(...).runs. `repo` is resolved from the run's own
// worktree, not from dirname(file): a registry-attached repo may keep its factory
// state root outside the checkout (#843/#894), so the state file's directory is not
// reliably inside the repo it describes. The resolver and the remote parser are the
// same ones FactoryEvent.repo uses (#971/#984) — one slug source for both envelopes.

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { resolveRepoSlug } from '../logger/repo-slug.js';
import type { CheckerOutput, FailurePhase, IssueRunState, RunStatus } from '../types/index.js';
import { isNumericWorkKey, issueNumberOf, toWorkKey, workKeyFromIssue, type WorkKey } from '../work/work-key.js';
import type { BuildRoute, RunOutcome } from './outcome.js';

/** Path of one issue's persisted run state inside `runsDir`
 *  (`getFactoryPaths(repoRoot).runs`). */
export function runStateFile(runsDir: string, key: WorkKey): string {
  return resolve(runsDir, `issue-${key}.json`);
}

/** Persists `state` with its string `key` (#3890), filling `repo` from the run's worktree when the
 *  caller did not supply one. A numeric key also persists the numeric `issue`, so a factory binary
 *  from before #3890 (0.9.27 or earlier) on the same host still reads the record (ADR-0168: no
 *  on-disk state migrates). A non-numeric key (a Linear or Jira ticket) persists no `issue`.
 *  Returns the in-memory record (both `key` and `issue`), so a caller can see the resolved slug.
 *  An unresolvable slug omits the key rather than writing a placeholder. */
export async function writeIssueRunState(file: string, state: IssueRunState): Promise<IssueRunState> {
  const repo = state.repo ?? resolveRepoSlug(state.worktree) ?? undefined;
  const key = state.key ?? workKeyFromIssue(state.issue);
  const { issue: _issue, key: _key, ...rest } = state;
  const legacy = isNumericWorkKey(key) ? { issue: issueNumberOf(key) } : {};
  const persisted = repo === undefined ? { ...legacy, ...rest } : { ...legacy, ...rest, repo };
  // `repo` must be absent, not undefined, in the JSON: JSON.stringify drops undefined
  // values, so the two shapes serialize identically — keep it that way.

  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ key, ...persisted }, null, 2)}\n`);
  await rename(tmp, file);
  return { ...persisted, key, issue: state.issue };
}

/** Reads one issue's persisted run state, or null when the file is missing,
 *  unreadable, or not a JSON object. Never throws. `repo` is surfaced when the record
 *  carries a non-empty string and is absent otherwise, so a record written before
 *  #972 reads back with `repo === undefined`. `key` is set from the persisted string key, or from
 *  the legacy numeric `issue` of a record written before #3890. */
export async function readIssueRunState(file: string): Promise<IssueRunState | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const { key: rawKey, ...rest } = parsed as IssueRunState & { key?: unknown };
  const record: IssueRunState = { ...rest };
  if (typeof rawKey === 'string') {
    try {
      const key = toWorkKey(rawKey);
      record.key = key;
      if (isNumericWorkKey(key)) record.issue = issueNumberOf(key);
    } catch {
      // An invalid key stays absent, so the record fails isValidIssueRunState.
    }
  } else if (Number.isSafeInteger(record.issue) && record.issue >= 0) {
    record.key = workKeyFromIssue(record.issue);
  }
  if (typeof record.repo !== 'string' || record.repo.length === 0) {
    const { repo: _dropped, ...withoutRepo } = record;
    return withoutRepo as IssueRunState;
  }
  return record;
}

export interface ListIssueRunsOptions {
  /** Keep only runs whose startedAt is on or after this instant. Invalid date → RangeError. */
  since?: Date;
  /** Run-store reader; defaults to readIssueRunState. Injected by tests. */
  readRun?: (file: string) => Promise<IssueRunState | null>;
}

export interface ListIssueRunsResult {
  /** Valid runs, sorted by issue ascending. */
  runs: IssueRunState[];
  /** issue-<n>.json file names that did not read as a valid run record, sorted by issue. */
  skipped: string[];
}

/** The one validity rule for a persisted run record (#3448): an object whose `key` equals the
 *  work key of the file name (#3890), with an integer `issue` and string `startedAt` and `updatedAt`. */
export function isValidIssueRunState(state: IssueRunState | null, key: WorkKey): state is IssueRunState {
  return (
    state !== null &&
    state.key !== undefined &&
    // A zero-padded file name (issue-007.json) still names the numeric key 7.
    (state.key === key || (isNumericWorkKey(state.key) && state.issue === Number(key))) &&
    Number.isInteger(state.issue) &&
    typeof state.startedAt === 'string' &&
    typeof state.updatedAt === 'string'
  );
}

/** Reads every `issue-<n>.json` in `runsDir` — the single owner of "which runs exist" (#3448).
 *  Names that are not `issue-<n>.json` (phase snapshots, .tmp files) are ignored; names that
 *  fail isValidIssueRunState are listed in `skipped`. A missing dir is an empty result. */
export async function listIssueRuns(runsDir: string, options: ListIssueRunsOptions = {}): Promise<ListIssueRunsResult> {
  const { since, readRun = readIssueRunState } = options;
  if (since !== undefined && Number.isNaN(since.getTime())) throw new RangeError('invalid since date');

  let names: string[];
  try {
    names = await readdir(runsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [], skipped: [] };
    throw err;
  }

  const files: { name: string; key: WorkKey }[] = [];
  for (const name of names) {
    const m = /^issue-(\d+)\.json$/.exec(name);
    if (m !== null) files.push({ name, key: toWorkKey(m[1]) });
  }
  files.sort((a, b) => Number(a.key) - Number(b.key) || (a.name < b.name ? -1 : 1));

  const runs: IssueRunState[] = [];
  const skipped: string[] = [];
  for (const { name, key } of files) {
    const state = await readRun(join(runsDir, name));
    if (!isValidIssueRunState(state, key)) {
      skipped.push(name);
      continue;
    }
    if (since !== undefined) {
      const started = Date.parse(state.startedAt);
      if (Number.isNaN(started) || started < since.getTime()) continue;
    }
    runs.push(state);
  }
  runs.sort((a, b) => a.issue - b.issue);
  return { runs, skipped };
}

/** What runIssue knows at a transition (#3194). Absent fields keep the previous record's value. */
export interface RunStateUpdate {
  status: RunStatus;
  branch?: string;
  route?: BuildRoute;
  model?: string;
  attempts?: number;
  prNumber?: number;
  failures?: CheckerOutput[];
  /** Why SHIP left the PR as a draft (#3932); recorded on the PR run-state comment. */
  draftReason?: 'ci-pending' | 'requested';
}

/** Fields the CLI fixes once per run. */
export interface IssueRunStateBase {
  issue: number;
  lane: string;
  branch: string;
  worktree: string;
  specPath: string;
  startedAt: string;
}

export function runStatusForPhase(phase: FailurePhase): RunStatus {
  switch (phase) {
    case 'plan':
      return 'planning';
    case 'build':
      return 'building';
    case 'check':
      return 'checking';
    case 'ship':
      return 'shipping';
  }
}

export function terminalRunStatus(outcome: RunOutcome): RunStatus {
  switch (outcome.state) {
    case 'ready':
    case 'shipped':
      return 'ready';
    case 'parked':
      return 'parked';
    case 'escalated':
      return 'escalated';
    case 'released':
      return 'pending';
  }
}

/** Merges `update` onto the previous in-memory record. Keys whose value is absent are omitted. */
export function nextIssueRunState(
  prev: IssueRunState | undefined,
  base: IssueRunStateBase,
  update: RunStateUpdate,
  now: string,
): IssueRunState {
  const prNumber = update.prNumber ?? prev?.prNumber;
  return {
    ...base,
    branch: update.branch ?? prev?.branch ?? base.branch,
    status: update.status,
    // IssueRunState.route is required, so before PLAN picks a route the packaged default
    // harness is recorded. The runs row does not expose route.
    route: update.route ?? prev?.route ?? 'claude',
    model: update.model ?? prev?.model ?? '',
    attempts: update.attempts ?? prev?.attempts ?? 1,
    startedAt: base.startedAt,
    updatedAt: now,
    ...(prNumber === undefined ? {} : { prNumber }),
    ...(update.failures !== undefined && update.failures.length > 0 ? { failures: update.failures } : {}),
    ...(prev?.remoteBranch === undefined ? {} : { remoteBranch: prev.remoteBranch }),
    ...(prev?.steers === undefined ? {} : { steers: prev.steers }),
  };
}
