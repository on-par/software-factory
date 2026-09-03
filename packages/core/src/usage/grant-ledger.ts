// src/usage/grant-ledger.ts — Shared on-disk grant ledger backing UsageCoordinator's
// admission-control acquire() API (#1030). Reservations record outstanding,
// not-yet-reflected capped-model work so independent engines don't over-commit the
// shared 5-hour Claude subscription cap.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { WriteUsageStateOptions } from './coordinator.js';
import { DEFAULT_USAGE_POLL_MS } from './constants.js';

export interface GrantRequest {
  repo: string;
  lane: string;
  phase: string;
  model: string;
}

export interface GrantLedgerEntry {
  id: string;
  repo: string;
  lane: string;
  phase: string;
  model: string;
  grantedAt: string; // ISO-8601
  reservationPct: number; // slice of the 5h window this grant reserves
}

export interface GrantLedger {
  version: 1;
  grants: GrantLedgerEntry[];
}

export type AcquireResult = { granted: true } | { granted: false; retryAfter: number }; // ms until retry

export const USAGE_ADMISSION_CEILING_PCT = 100; // do not project past a full 5h window
export const USAGE_GRANT_RESERVATION_PCT = 20; // each in-flight capped phase reserves ~20%
export const DEFAULT_GRANT_TTL_MS = 2 * DEFAULT_USAGE_POLL_MS; // assumed reflected after ~2 polls

export function defaultGrantLedgerPath(home?: string): string {
  return join(home ?? homedir(), '.factory', 'usage', 'grants.json');
}

/** Coarse routing predicate: everything Claude-branded is capped by the subscription
 *  window; every other model bypasses this gate. Non-Claude route gating is out of
 *  scope here. */
export function isCappedModel(model: string): boolean {
  return model.startsWith('claude-');
}

function emptyGrantLedger(): GrantLedger {
  return { version: 1, grants: [] };
}

function isEntry(value: unknown): value is GrantLedgerEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<GrantLedgerEntry>;
  return (
    typeof e.id === 'string' &&
    typeof e.repo === 'string' &&
    typeof e.lane === 'string' &&
    typeof e.phase === 'string' &&
    typeof e.model === 'string' &&
    typeof e.grantedAt === 'string' &&
    typeof e.reservationPct === 'number' &&
    Number.isFinite(e.reservationPct)
  );
}

/** Reads the persisted grant ledger. A missing file, unparsable JSON, a non-object
 *  payload, or a non-array `grants` all yield an empty ledger — this NEVER throws
 *  and NEVER creates the file. Individual malformed entries are dropped. */
export async function loadGrantLedger(file: string): Promise<GrantLedger> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch {
    return emptyGrantLedger();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyGrantLedger();
  }
  if (!parsed || typeof parsed !== 'object') return emptyGrantLedger();
  const candidate = parsed as { grants?: unknown };
  if (!Array.isArray(candidate.grants)) return emptyGrantLedger();
  return { version: 1, grants: candidate.grants.filter(isEntry) };
}

/** Atomic write: mkdir the parent, serialize to `${file}.tmp`, then rename it onto
 *  `file`. Mirrors `writeUsageState`. */
export async function writeGrantLedger(
  file: string,
  ledger: GrantLedger,
  opts: WriteUsageStateOptions = {},
): Promise<void> {
  const write = opts.writeFile ?? ((f: string, data: string) => writeFile(f, data));
  const move = opts.rename ?? ((from: string, to: string) => rename(from, to));
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await write(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  await move(tmp, file);
}

/** Pure: drops grants older than `ttlMs`, on the assumption their work has by then
 *  been reflected in the polled snapshot. */
export function pruneGrants(grants: GrantLedgerEntry[], now: number, ttlMs: number): GrantLedgerEntry[] {
  return grants.filter((g) => {
    const t = Date.parse(g.grantedAt);
    return Number.isFinite(t) && now - t < ttlMs;
  });
}
