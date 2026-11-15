import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface AwaitingCiRecord {
  issue: number;
  prNumber: number;
  branch: string;
  headSha: string;
  firstSeenAt: number;
  attempts: number;
  nextRecheckAt: number;
}

export const AWAITING_CI_BACKOFF_MS: readonly number[] = [2, 5, 15].map((m) => m * 60_000);
export const AWAITING_CI_INTERVAL_MS = 30 * 60_000;
const DEFAULT_AWAITING_CI_CAP_HOURS = 24;

export function nextRecheckAt(firstSeenAt: number, attempts: number): number {
  if (attempts < AWAITING_CI_BACKOFF_MS.length) return firstSeenAt + AWAITING_CI_BACKOFF_MS[attempts];
  const last = AWAITING_CI_BACKOFF_MS[AWAITING_CI_BACKOFF_MS.length - 1];
  return firstSeenAt + last + (attempts - AWAITING_CI_BACKOFF_MS.length + 1) * AWAITING_CI_INTERVAL_MS;
}

export function resolveAwaitingCiCapMs(config: { ci?: { awaitingCiCapHours?: number } }): number {
  const h = config.ci?.awaitingCiCapHours;
  const hours = typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : DEFAULT_AWAITING_CI_CAP_HOURS;
  return hours * 3_600_000;
}

export function awaitingCiFile(paths: { state: string }): string {
  return join(paths.state, 'awaiting-ci.json');
}

function isRecord(v: unknown): v is AwaitingCiRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.issue === 'number' &&
    typeof r.prNumber === 'number' &&
    typeof r.branch === 'string' &&
    typeof r.headSha === 'string' &&
    typeof r.firstSeenAt === 'number' &&
    typeof r.attempts === 'number' &&
    typeof r.nextRecheckAt === 'number'
  );
}

export async function readAwaitingCi(file: string): Promise<AwaitingCiRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

async function writeAll(file: string, records: readonly AwaitingCiRecord[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export async function upsertAwaitingCi(file: string, record: AwaitingCiRecord): Promise<void> {
  const rest = (await readAwaitingCi(file)).filter((r) => r.issue !== record.issue);
  await writeAll(file, [...rest, record]);
}

export async function clearAwaitingCi(file: string, issue: number): Promise<void> {
  const all = await readAwaitingCi(file);
  const rest = all.filter((r) => r.issue !== issue);
  if (rest.length !== all.length) await writeAll(file, rest);
}
