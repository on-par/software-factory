import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { resolveRepoSlug } from '../logger/repo-slug.js';
import type { CheckerOutput, FailurePhase, IssueRunState, RunStatus } from '../types/index.js';
import { isNumericWorkKey, issueNumberOf, toWorkKey, workKeyFromIssue, type WorkKey } from '../work/work-key.js';
import type { BuildRoute, RunOutcome } from './outcome.js';

export function runStateFile(runsDir: string, key: WorkKey): string {
  return resolve(runsDir, `issue-${key}.json`);
}

export async function writeIssueRunState(file: string, state: IssueRunState): Promise<IssueRunState> {
  const repo = state.repo ?? resolveRepoSlug(state.worktree) ?? undefined;
  const key = state.key ?? workKeyFromIssue(state.issue);
  const { issue: _issue, key: _key, ...rest } = state;
  const legacy = isNumericWorkKey(key) ? { issue: issueNumberOf(key) } : {};
  const persisted = repo === undefined ? { ...legacy, ...rest } : { ...legacy, ...rest, repo };

  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ key, ...persisted }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return { ...persisted, key, issue: state.issue };
}

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
    } catch {}
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
  since?: Date;
  readRun?: (file: string) => Promise<IssueRunState | null>;
}

export interface ListIssueRunsResult {
  runs: IssueRunState[];
  skipped: string[];
}

export function isValidIssueRunState(state: IssueRunState | null, key: WorkKey): state is IssueRunState {
  return (
    state !== null &&
    state.key !== undefined &&
    (state.key === key || (isNumericWorkKey(state.key) && state.issue === Number(key))) &&
    Number.isInteger(state.issue) &&
    typeof state.startedAt === 'string' &&
    typeof state.updatedAt === 'string'
  );
}

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

export interface RunStateUpdate {
  status: RunStatus;
  branch?: string;
  route?: BuildRoute;
  model?: string;
  attempts?: number;
  prNumber?: number;
  failures?: CheckerOutput[];
  draftReason?: 'ci-pending' | 'requested';
  ciReworkRound?: { prNumber: number; round: number };
}

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
