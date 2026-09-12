// src/daemon/run-store.ts — Durable daemon run records: one JSON file per run
// id under ~/.factory/runs. The final-path 'wx' create is the idempotency
// fence; subsequent state changes use atomic replacement (ADR #1393).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type DaemonRunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface DaemonRunRecord {
  runId: string;
  repo: string;
  issue: number;
  status: DaemonRunStatus;
  submittedAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  detail?: string;
}

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DAEMON_RUN_STATUSES = new Set<string>(['queued', 'running', 'succeeded', 'failed']);
export const MAX_DETAIL_CHARS = 500;

export function isValidRunId(runId: unknown): runId is string {
  return typeof runId === 'string' && RUN_ID_RE.test(runId);
}

export function daemonRunFile(runsDir: string, runId: string): string {
  if (!isValidRunId(runId)) throw new RangeError(`invalid run id: ${JSON.stringify(runId)}`);
  return resolve(runsDir, `${runId}.json`);
}

function isRecord(value: unknown): value is DaemonRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Partial<DaemonRunRecord>;
  return (
    isValidRunId(r.runId) &&
    typeof r.repo === 'string' &&
    Number.isInteger(r.issue) &&
    DAEMON_RUN_STATUSES.has(r.status as string) &&
    typeof r.submittedAt === 'string' &&
    typeof r.updatedAt === 'string' &&
    (r.startedAt === undefined || typeof r.startedAt === 'string') &&
    (r.finishedAt === undefined || typeof r.finishedAt === 'string') &&
    (r.detail === undefined || typeof r.detail === 'string')
  );
}

function cleanRecord(record: DaemonRunRecord): DaemonRunRecord {
  return {
    runId: record.runId,
    repo: record.repo,
    issue: record.issue,
    status: record.status,
    submittedAt: record.submittedAt,
    updatedAt: record.updatedAt,
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    ...(record.detail === undefined ? {} : { detail: record.detail }),
  };
}

function serialize(record: DaemonRunRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export async function readDaemonRun(file: string): Promise<DaemonRunRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf-8'));
    return isRecord(parsed) ? cleanRecord(parsed) : null;
  } catch {
    return null;
  }
}

export async function createDaemonRunExclusive(file: string, record: DaemonRunRecord): Promise<'created' | 'exists'> {
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(file, serialize(record), { flag: 'wx' });
    return 'created';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw err;
  }
}

export async function writeDaemonRun(file: string, record: DaemonRunRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, serialize(record));
  await rename(tmp, file);
}
