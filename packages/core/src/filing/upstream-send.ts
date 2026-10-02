// src/filing/upstream-send.ts — Send upstream factory reports with outbox fallback and per-operator caps (#1860).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { FactoryLogger } from '../logger/index.js';
import { DEFAULT_INTERNAL_REPO, type FilingGitHubClient } from './index.js';
import { emptyLedger, type FilingLedger, type FilingPolicy, recordFiled, rollDay } from './policy.js';
import type { UpstreamReport } from './upstream.js';

export function defaultUpstreamOutboxDir(home?: string): string {
  return join(home ?? homedir(), '.factory', 'filing', 'outbox');
}

export function defaultUpstreamLedgerPath(home?: string): string {
  return join(home ?? homedir(), '.factory', 'filing', 'upstream-ledger.json');
}

export interface UpstreamOutboxEntry {
  version: 1;
  fingerprint: string;
  /** Target factory repo, e.g. on-par/software-factory. */
  repo: string;
  title: string;
  body: string;
  /** Why the report was outboxed. */
  reason: string;
  createdAt: string;
}

export interface PendingUpstreamReport {
  fingerprint: string;
  report: UpstreamReport;
}

export interface UpstreamSendInput {
  reports: readonly PendingUpstreamReport[];
  /** Client built from the run's GitHub auth; null when no auth was resolved. */
  client: Pick<FilingGitHubClient, 'createIssue'> | null;
  repo?: string;
  policy: Pick<FilingPolicy, 'enabled' | 'maxPerRun' | 'maxPerDay'>;
  ledgerFile?: string;
  outboxDir?: string;
  logger?: Pick<FactoryLogger, 'info' | 'warn'>;
  now?: () => Date;
}

export type UpstreamSendOutcome = 'created' | 'outboxed' | 'skipped';

export interface UpstreamSendResult {
  fingerprint: string;
  outcome: UpstreamSendOutcome;
  issueNumber?: number;
  outboxPath?: string;
  reason?: string;
}

export function classifyUpstreamSendError(err: unknown): string {
  const obj = typeof err === 'object' && err !== null ? (err as { status?: unknown; message?: unknown }) : {};
  const status = typeof obj.status === 'number' ? obj.status : undefined;
  if (status === 401) return 'unauthorized (401)';
  if (status === 403) return 'forbidden (403)';
  if (status === 404) return 'not-found-or-no-access (404)';
  if (status === 410) return 'issues-disabled (410)';
  if (status !== undefined) return `http-${status}`;
  const first = typeof obj.message === 'string' ? (obj.message.split('\n')[0] ?? '').trim().slice(0, 120) : '';
  return first ? `send-failed: ${first}` : 'send-failed';
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

export async function writeUpstreamOutbox(dir: string, entry: UpstreamOutboxEntry): Promise<string> {
  await mkdir(dir, { recursive: true });
  const name = /^[A-Za-z0-9_-]{1,64}$/.test(entry.fingerprint) ? entry.fingerprint : `invalid-${Date.now()}`;
  const file = join(dir, `${name}.json`);
  await writeAtomic(file, `${JSON.stringify(entry, null, 2)}\n`);
  return file;
}

async function loadLedger(file: string, now: () => Date): Promise<FilingLedger> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const p = parsed as Partial<FilingLedger>;
      if (
        typeof p.day === 'string' &&
        typeof p.filedToday === 'number' &&
        Number.isFinite(p.filedToday) &&
        typeof p.occurrences === 'object' &&
        p.occurrences !== null
      ) {
        return { day: p.day, filedToday: p.filedToday, filedThisRun: 0, occurrences: p.occurrences };
      }
    }
  } catch {
    // unreadable or corrupt: treat as empty
  }
  return emptyLedger(now);
}

async function saveLedger(file: string, ledger: FilingLedger): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeAtomic(file, `${JSON.stringify(ledger, null, 2)}\n`);
  } catch {
    // best-effort
  }
}

export async function sendUpstreamReports(input: UpstreamSendInput): Promise<UpstreamSendResult[]> {
  const now = input.now ?? (() => new Date());
  const repo = input.repo ?? DEFAULT_INTERNAL_REPO;
  const [owner = '', name = ''] = repo.split('/');
  const { logger, client, policy } = input;
  const ledgerFile = input.ledgerFile ?? defaultUpstreamLedgerPath();
  const outboxDir = input.outboxDir ?? defaultUpstreamOutboxDir();
  const results: UpstreamSendResult[] = [];

  const skip = (fingerprint: string, reason: string): void => {
    logger?.info('upstream_report_skipped', `Upstream report ${fingerprint} skipped: ${reason}`, { fingerprint });
    results.push({ fingerprint, outcome: 'skipped', reason });
  };

  if (!policy.enabled) {
    for (const { fingerprint } of input.reports) skip(fingerprint, 'filing-disabled');
    return results;
  }

  let ledger = rollDay({ ...(await loadLedger(ledgerFile, now)), filedThisRun: 0 }, now);
  const seen = new Set<string>();

  const outbox = async (pending: PendingUpstreamReport, reason: string): Promise<void> => {
    const { fingerprint, report } = pending;
    try {
      const outboxPath = await writeUpstreamOutbox(outboxDir, {
        version: 1,
        fingerprint,
        repo,
        title: report.title,
        body: report.body,
        reason,
        createdAt: now().toISOString(),
      });
      logger?.warn('upstream_report_outboxed', `Upstream report ${fingerprint} outboxed: ${reason}`, { fingerprint });
      results.push({ fingerprint, outcome: 'outboxed', outboxPath, reason });
    } catch {
      const full = `${reason}; outbox write failed`;
      logger?.warn('upstream_report_outboxed', `Upstream report ${fingerprint} outboxed: ${full}`, { fingerprint });
      results.push({ fingerprint, outcome: 'outboxed', reason: full });
    }
  };

  for (const pending of input.reports) {
    const { fingerprint, report } = pending;
    if (seen.has(fingerprint)) {
      skip(fingerprint, 'duplicate-in-run');
      continue;
    }
    seen.add(fingerprint);

    ledger = rollDay(ledger, now);
    if (ledger.filedToday >= policy.maxPerDay) {
      skip(fingerprint, 'per-day-cap');
      continue;
    }
    if (ledger.filedThisRun >= policy.maxPerRun) {
      skip(fingerprint, 'per-run-cap');
      continue;
    }

    if (client === null) {
      await outbox(pending, 'no-auth');
      continue;
    }
    try {
      const { number } = await client.createIssue({
        owner,
        repo: name,
        title: report.title,
        body: report.body,
        labels: [],
      });
      ledger = recordFiled(ledger, now);
      await saveLedger(ledgerFile, ledger);
      logger?.info('upstream_report_sent', `Filed upstream report ${repo}#${number}`, { fingerprint });
      results.push({ fingerprint, outcome: 'created', issueNumber: number });
    } catch (err) {
      await outbox(pending, classifyUpstreamSendError(err));
    }
  }
  return results;
}
