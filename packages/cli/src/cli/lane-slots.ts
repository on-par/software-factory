// packages/cli/src/cli/lane-slots.ts — the running and waiting lanes of the active `factory run`, recorded so a
// separate `factory status` process can show them against run.maxLanes (#3958).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { CliExitError } from './errors.js';

export interface LaneSlotsState {
  maxLanes: number | null;
  source: 'flag' | 'config' | 'unset';
  running: string[];
  waiting: string[];
  updatedAt: string;
  pid: number;
}

export function writeLaneSlots(file: string, state: LaneSlotsState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Fails soft: a missing, unreadable, non-JSON or wrong-shape file reads as null. */
export function readLaneSlots(file: string): LaneSlotsState | null {
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { maxLanes, source, running, waiting, updatedAt, pid } = raw as Record<string, unknown>;
  if (maxLanes !== null && typeof maxLanes !== 'number') return null;
  if (source !== 'flag' && source !== 'config' && source !== 'unset') return null;
  if (!isStringArray(running) || !isStringArray(waiting)) return null;
  if (typeof updatedAt !== 'string' || typeof pid !== 'number') return null;
  return { maxLanes, source, running, waiting, updatedAt, pid };
}

export function clearLaneSlots(file: string): void {
  rmSync(file, { force: true });
}

export function formatLaneSlotsSection(state: LaneSlotsState | null): string[] {
  if (state === null) return ['  (no factory run active)'];
  const head =
    state.maxLanes === null
      ? `  lanes ${state.running.length} running (no cap)`
      : `  lanes ${state.running.length}/${state.maxLanes} running (cap from ${
          state.source === 'flag' ? '--max-lanes' : 'run.maxLanes'
        })`;
  const lines = [head, `  running: ${state.running.join(', ')}`];
  if (state.waiting.length > 0) lines.push(`  waiting for a slot: ${state.waiting.join(', ')}`);
  return lines;
}

/** `--max-lanes <n>`: a positive integer, or exit 2. */
export function parseMaxLanesFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new CliExitError(`factory: --max-lanes must be a positive integer (got '${raw}')`, 2);
  }
  return Number(raw);
}
