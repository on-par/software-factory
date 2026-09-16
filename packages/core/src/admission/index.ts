// packages/core/src/admission/index.ts — Factory App admission-state compatibility for the GitHub-label queue (#1497).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { QueuePreflight } from '../queue/github-queue.js';

export type AdmissionState = 'admitted' | 'executing' | 'decomposed' | 'released';

/** One Factory App record for a GitHub issue. Factory App is the writer; the CLI only reads. */
export interface AdmissionRecord {
  issue: number;
  state: AdmissionState;
  /** Factory App delivery that owns the issue. */
  deliveryId?: string;
  /** Parent issue when this issue is a Factory App decomposition child. */
  parent?: number;
  /** ISO timestamp of Factory App's last write. */
  updatedAt?: string;
  /** Repair-flow pointer supplied by Factory App; overrides FACTORY_APP_REPAIR_HINT. */
  repairUrl?: string;
}

/** A read never throws for a missing record: absence is a value, not an error. */
export type AdmissionLookup =
  { kind: 'absent' } | { kind: 'record'; record: AdmissionRecord } | { kind: 'unreadable'; detail: string };

export interface AdmissionStateReader {
  read(issue: number): Promise<AdmissionLookup>;
}

export type QueueCompatibilityVerdict =
  { kind: 'claimable' } | { kind: 'refuse'; state: AdmissionState | 'unreadable'; reason: string; repair: string };

export const ADMISSION_STATE_FILENAME = 'admission.json';
export const ADMISSION_SNAPSHOT_VERSION = 1;
export const FACTORY_APP_REPAIR_HINT =
  'Factory App → Deliveries → Repair: release or re-run the delivery there before claiming this issue from the CLI';

const ADMISSION_STATES: readonly AdmissionState[] = ['admitted', 'executing', 'decomposed', 'released'];

function isAdmissionState(value: unknown): value is AdmissionState {
  return typeof value === 'string' && (ADMISSION_STATES as readonly string[]).includes(value);
}

/** Pure — branches only on `lookup.kind` and `record.state`, never a free-text detail (ADR-0094). */
export function classifyQueueCompatibility(issue: number, lookup: AdmissionLookup): QueueCompatibilityVerdict {
  if (lookup.kind === 'absent') return { kind: 'claimable' };

  if (lookup.kind === 'unreadable') {
    return {
      kind: 'refuse',
      state: 'unreadable',
      reason: `Factory App admission state is unreadable (${lookup.detail}) — refusing rather than risking duplicate work`,
      repair: FACTORY_APP_REPAIR_HINT,
    };
  }

  const { record } = lookup;
  if (record.state === 'released') return { kind: 'claimable' };

  const repair = record.repairUrl ?? FACTORY_APP_REPAIR_HINT;
  const delivery = record.deliveryId ?? '(unnamed)';
  if (record.state === 'admitted') {
    return {
      kind: 'refuse',
      state: 'admitted',
      reason: `#${issue} is admitted to Factory App delivery ${delivery} — GitHub labels are intake eligibility only`,
      repair,
    };
  }
  if (record.state === 'executing') {
    return {
      kind: 'refuse',
      state: 'executing',
      reason: `#${issue} is executing in Factory App delivery ${delivery}`,
      repair,
    };
  }

  const reason =
    record.parent !== undefined
      ? `#${issue} was decomposed by Factory App (child of #${record.parent})`
      : `#${issue} was decomposed by Factory App into child issues — it is not an independent unit of work`;
  return { kind: 'refuse', state: 'decomposed', reason, repair };
}

export function formatAdmissionConflict(
  issue: number,
  verdict: Extract<QueueCompatibilityVerdict, { kind: 'refuse' }>,
): string {
  return `#${issue}: ${verdict.reason}\n    repair: ${verdict.repair}`;
}

export function withAdmissionGuard(opts: {
  reader?: AdmissionStateReader;
  preflight?: QueuePreflight;
  onConflict?: (issue: number, verdict: Extract<QueueCompatibilityVerdict, { kind: 'refuse' }>) => void;
}): QueuePreflight {
  const { reader, preflight, onConflict } = opts;
  return async (candidate) => {
    const inner = async () => (await preflight?.(candidate)) ?? { kind: 'build' as const };
    if (!reader) return inner();

    let lookup: AdmissionLookup;
    try {
      lookup = await reader.read(candidate.number);
    } catch (err) {
      lookup = { kind: 'unreadable', detail: err instanceof Error ? err.message : String(err) };
    }

    const verdict = classifyQueueCompatibility(candidate.number, lookup);
    if (verdict.kind === 'refuse') {
      onConflict?.(candidate.number, verdict);
      // A conflict must never write a GitHub label — parking would mutate state an in-flight
      // Factory App delivery may own, so the guard defers non-destructively instead.
      return { kind: 'defer' };
    }
    return inner();
  };
}

export function createFileAdmissionStateReader(opts: {
  stateDir: string;
  readFile?: (path: string) => string | null;
}): AdmissionStateReader {
  const readFile = opts.readFile ?? ((p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null));

  return {
    async read(issue: number): Promise<AdmissionLookup> {
      const raw = readFile(join(opts.stateDir, ADMISSION_STATE_FILENAME));
      if (raw === null) return { kind: 'absent' };

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { kind: 'unreadable', detail: 'admission.json is not valid JSON' };
      }

      if (typeof parsed !== 'object' || parsed === null) {
        return { kind: 'unreadable', detail: 'admission.json is not an object' };
      }
      const { version, records } = parsed as { version?: unknown; records?: unknown };
      if (version !== ADMISSION_SNAPSHOT_VERSION) {
        return { kind: 'unreadable', detail: `unsupported admission snapshot version ${String(version)}` };
      }
      if (!Array.isArray(records)) {
        return { kind: 'unreadable', detail: 'admission.json records is not an array' };
      }

      const found = (records as AdmissionRecord[]).find((r) => r?.issue === issue);
      if (found === undefined) return { kind: 'absent' };

      if (!isAdmissionState(found.state)) {
        return { kind: 'unreadable', detail: `issue #${issue} has unknown admission state "${String(found.state)}"` };
      }

      const record: AdmissionRecord = { issue: found.issue, state: found.state };
      if (found.deliveryId !== undefined) record.deliveryId = found.deliveryId;
      if (found.parent !== undefined) record.parent = found.parent;
      if (found.updatedAt !== undefined) record.updatedAt = found.updatedAt;
      if (found.repairUrl !== undefined) record.repairUrl = found.repairUrl;

      return { kind: 'record', record };
    },
  };
}
