// src/daemon/runs-submit.ts — Submit and execute durable explicit daemon runs
// (#1393). Submission's exclusive record create is the idempotency fence.

import type { DaemonLaneContext } from './lane-context.js';
import {
  createDaemonRunExclusive,
  daemonRunFile,
  isValidRunId,
  MAX_DETAIL_CHARS,
  readDaemonRun,
  type DaemonRunRecord,
  writeDaemonRun,
} from './run-store.js';
import { getRepo, loadRegistry, type RepoRegistryListing } from './registry.js';

export interface SubmitRunRequest {
  runId: string;
  repo: string;
  issue: number;
}
export type SubmitRunFailureReason =
  'invalid-request' | 'unknown-repo' | 'repo-not-dispatchable' | 'unreadable-run-record';
export type SubmitDaemonRunResult =
  | { ok: true; created: true; run: DaemonRunRecord; entry: RepoRegistryListing }
  | { ok: true; created: false; run: DaemonRunRecord }
  | { ok: false; reason: SubmitRunFailureReason; detail: string };
export interface DaemonRunDeps {
  now?: () => Date;
  log?: (line: string) => void;
}
export type DaemonRunExecutor = (run: DaemonRunRecord, context: DaemonLaneContext) => Promise<void>;

const SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function parseSubmitRequest(body: unknown): { ok: true; request: SubmitRunRequest } | { ok: false; detail: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, detail: 'expected { runId, repo, issue }' };
  const { runId, repo, issue } = body as Partial<SubmitRunRequest>;
  if (!isValidRunId(runId)) return { ok: false, detail: `invalid runId: ${JSON.stringify(runId)}` };
  if (typeof repo !== 'string' || !SLUG_RE.test(repo))
    return { ok: false, detail: `invalid repo: ${JSON.stringify(repo)}` };
  if (typeof issue !== 'number' || !Number.isInteger(issue) || issue <= 0)
    return { ok: false, detail: `invalid issue: ${JSON.stringify(issue)}` };
  return { ok: true, request: { runId, repo, issue } };
}

export async function submitDaemonRun(
  registryFile: string,
  runsDir: string,
  body: unknown,
  deps: DaemonRunDeps = {},
): Promise<SubmitDaemonRunResult> {
  const parsed = parseSubmitRequest(body);
  if (!parsed.ok) return { ok: false, reason: 'invalid-request', detail: parsed.detail };
  const { runId, repo, issue } = parsed.request;
  const file = daemonRunFile(runsDir, runId);
  const existing = await readDaemonRun(file);
  if (existing !== null) return { ok: true, created: false, run: existing };
  const entry = getRepo(await loadRegistry(registryFile), repo);
  if (entry === undefined) return { ok: false, reason: 'unknown-repo', detail: `${repo} is not attached` };
  if (entry.state !== 'active')
    return { ok: false, reason: 'repo-not-dispatchable', detail: `${repo} is ${entry.state}` };
  const ts = (deps.now?.() ?? new Date()).toISOString();
  const run: DaemonRunRecord = { runId, repo, issue, status: 'queued', submittedAt: ts, updatedAt: ts };
  if ((await createDaemonRunExclusive(file, run)) === 'created')
    return { ok: true, created: true, run, entry: { slug: repo, ...entry } };
  const winner = await readDaemonRun(file);
  return winner === null
    ? { ok: false, reason: 'unreadable-run-record', detail: `${file} exists but is not a readable run record` }
    : { ok: true, created: false, run: winner };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function truncate(detail: string): string {
  return detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS - 1)}…` : detail;
}

export async function executeDaemonRun(
  runsDir: string,
  run: DaemonRunRecord,
  context: DaemonLaneContext,
  execute: DaemonRunExecutor,
  deps: DaemonRunDeps = {},
): Promise<DaemonRunRecord> {
  const save = async (record: DaemonRunRecord): Promise<void> => {
    await writeDaemonRun(daemonRunFile(runsDir, record.runId), record).catch((err: unknown) =>
      deps.log?.(`daemon run ${record.runId}: state write failed: ${message(err)}`),
    );
  };
  const startedAt = (deps.now?.() ?? new Date()).toISOString();
  const running = { ...run, status: 'running' as const, startedAt, updatedAt: startedAt };
  await save(running);
  let terminal: DaemonRunRecord;
  const finishedAt = () => (deps.now?.() ?? new Date()).toISOString();
  try {
    await execute(running, context);
    const timestamp = finishedAt();
    terminal = { ...running, status: 'succeeded', finishedAt: timestamp, updatedAt: timestamp };
  } catch (err) {
    const timestamp = finishedAt();
    terminal = {
      ...running,
      status: 'failed',
      finishedAt: timestamp,
      updatedAt: timestamp,
      detail: truncate(message(err)),
    };
  }
  await save(terminal);
  return terminal;
}
