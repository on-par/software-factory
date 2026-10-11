import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { UPDATE_MODES, type FactorydConfig, type InstallKind, type UpdateChannel, type UpdateMode } from './daemon.js';

export const UPDATE_OUTCOMES = ['updated', 'rolled-back', 'failed', 'skipped'] as const;
export type UpdateOutcome = (typeof UPDATE_OUTCOMES)[number];

export interface UpdateLastResult {
  at: string;
  version: string;
  outcome: UpdateOutcome;
  error?: string;
}

export interface UpdateDraining {
  since: string;
  target: string;
}

/** On-disk shape of <daemon state dir>/update-state.json (#2129). */
export interface UpdateState {
  schemaVersion: 1;
  mode: UpdateMode;
  channel: UpdateChannel | null;
  installKind: InstallKind;
  current: string;
  available: string | null;
  lastCheckAt: string | null;
  lastResult: UpdateLastResult | null;
  draining: UpdateDraining | null;
}

/** `update` in `factory status --json` — UpdateState without schemaVersion. */
export type StatusUpdateJson = Omit<UpdateState, 'schemaVersion'>;

const INSTALL_KINDS: readonly InstallKind[] = ['npm-global', 'source', 'unknown'];

export function updateStatePath(stateDir: string): string {
  return join(stateDir, 'update-state.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseLastResult(value: unknown): UpdateLastResult | null {
  if (!isRecord(value)) return null;
  const { at, version, outcome, error } = value;
  if (typeof at !== 'string' || typeof version !== 'string') return null;
  if (!(UPDATE_OUTCOMES as readonly unknown[]).includes(outcome)) return null;
  const result: UpdateLastResult = { at, version, outcome: outcome as UpdateOutcome };
  if (typeof error === 'string') result.error = error;
  return result;
}

function parseDraining(value: unknown): UpdateDraining | null {
  if (!isRecord(value)) return null;
  if (typeof value.since !== 'string' || typeof value.target !== 'string') return null;
  return { since: value.since, target: value.target };
}

/** Tolerant reader: a missing or invalid file is `null`; never throws. */
export function readUpdateState(file: string): UpdateState | null {
  try {
    if (!existsSync(file)) return null;
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    if (!isRecord(raw)) return null;
    if (!(UPDATE_MODES as readonly unknown[]).includes(raw.mode)) return null;
    if (typeof raw.current !== 'string' || raw.current === '') return null;
    return {
      schemaVersion: 1,
      mode: raw.mode as UpdateMode,
      channel: raw.channel === 'latest' || raw.channel === 'next' ? raw.channel : null,
      installKind: INSTALL_KINDS.includes(raw.installKind as InstallKind)
        ? (raw.installKind as InstallKind)
        : 'unknown',
      current: raw.current,
      available: stringOrNull(raw.available),
      lastCheckAt: stringOrNull(raw.lastCheckAt),
      lastResult: parseLastResult(raw.lastResult),
      draining: parseDraining(raw.draining),
    };
  } catch {
    return null;
  }
}

/** Atomic write (tmp + rename) so a concurrent `factory status` never reads a torn file. */
export function writeUpdateState(file: string, state: UpdateState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

export function initialUpdateState(
  config: Pick<FactorydConfig, 'autoUpdate' | 'install'>,
  previous: UpdateState | null,
): UpdateState {
  const { mode, channel } = config.autoUpdate;
  const current = config.install.version;
  const carried = previous?.available ?? null;
  return {
    schemaVersion: 1,
    mode,
    channel,
    installKind: config.install.kind,
    current,
    available: mode === 'manual' || carried === current ? null : carried,
    lastCheckAt: previous?.lastCheckAt ?? null,
    lastResult: previous?.lastResult ?? null,
    draining: null,
  };
}

export function buildStatusUpdateJson(state: UpdateState | null): StatusUpdateJson | null {
  if (!state) return null;
  const { schemaVersion: _schemaVersion, ...update } = state;
  return { ...update, available: state.mode === 'manual' ? null : state.available };
}

function installLabel(kind: InstallKind): string {
  switch (kind) {
    case 'npm-global':
      return 'npm';
    case 'source':
      return 'source';
    case 'unknown':
      return 'unknown install';
  }
}

function outcomeLabel(outcome: UpdateOutcome): string {
  switch (outcome) {
    case 'updated':
      return 'updated';
    case 'rolled-back':
      return 'rolled back';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
  }
}

/** The one human line `factory status` prints for the update state. */
export function formatUpdateStatusLine(update: StatusUpdateJson | null): string {
  if (!update) return 'factory update: no factoryd update state (daemon not started?)';
  let line = `factory ${update.current} (${update.mode}, ${installLabel(update.installKind)})`;
  if (update.mode === 'manual') line += ' — automatic updates off';
  else if (update.available !== null && update.available !== update.current) line += ` — ${update.available} available`;
  else line += ' — up to date';
  if (update.lastResult) {
    const { version, outcome, error } = update.lastResult;
    line += `; last update to ${version} ${outcomeLabel(outcome)}`;
    if (error) line += ` (${error})`;
  }
  if (update.draining) line += `; draining for ${update.draining.target} since ${update.draining.since}`;
  return line;
}

export function formatUpdateStartupLine(state: UpdateState): string {
  return `update: factory ${state.current}, mode ${state.mode} (channel ${state.channel ?? 'none'}, install ${state.installKind})`;
}

export function formatUpdateCheckLine(state: UpdateState): string {
  const found = state.available && state.available !== state.current ? `${state.available} available` : 'up to date';
  return `update check: ${found} on ${state.channel ?? 'none'} (current ${state.current})`;
}

/** Records one check result and logs it once. Seam for the later update checker; no production caller yet. */
export function recordUpdateCheck(
  file: string,
  check: { at: string; available: string | null },
  log: (line: string) => void,
): UpdateState | null {
  const state = readUpdateState(file);
  if (!state) return null;
  const next: UpdateState = { ...state, lastCheckAt: check.at, available: check.available };
  writeUpdateState(file, next);
  log(formatUpdateCheckLine(next));
  return next;
}
