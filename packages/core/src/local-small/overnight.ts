import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type OvernightPreflightResult = { ok: true } | { ok: false; reason: string };

export type OvernightItemStatus = 'ready' | 'parked' | 'failed';

export interface OvernightItemOutcome {
  status: OvernightItemStatus;
  reason?: string;
}

export interface OvernightStateItem {
  issue: number;
  status: OvernightItemStatus;
  reason?: string;
  finishedAt: string;
}

export interface OvernightQueueState {
  profile: 'local-small-overnight';
  startedAt: string;
  items: OvernightStateItem[];
}

export interface OvernightQueueInput {
  issues: number[];
  statePath: string;
  now?: () => Date;
}

export interface OvernightQueueDeps {
  /** Called before EACH item. Not-ok halts the run (environment problems affect every later item). */
  preflight: (issue: number) => Promise<OvernightPreflightResult>;
  /** Process one issue end-to-end. Must NOT merge anything. Throwing maps to status 'failed'. */
  processItem: (issue: number) => Promise<OvernightItemOutcome>;
  /** Invoked for every parked or failed item so the caller can surface a report. */
  report?: (item: OvernightStateItem) => Promise<void> | void;
  log?: (type: string, msg: string) => void;
}

export interface OvernightQueueResult {
  /** Items processed in THIS run, in queue order. */
  processed: OvernightStateItem[];
  /** Issues skipped because a prior run already recorded an outcome for them. */
  skipped: number[];
  /** Set when a preflight failure stopped the run before this issue was processed. */
  halted?: { issue: number; reason: string };
  statePath: string;
}

export async function runOvernightQueue(
  input: OvernightQueueInput,
  deps: OvernightQueueDeps,
): Promise<OvernightQueueResult> {
  for (const issue of input.issues) {
    if (!Number.isInteger(issue) || issue < 1) {
      throw new Error(`runOvernightQueue: invalid issue number '${issue}' — expected a positive integer`);
    }
  }

  const now = input.now ?? (() => new Date());
  const state = await loadState(input.statePath, now);

  const seen = new Set(state.items.map((item) => item.issue));
  const skipped: number[] = [];
  const processed: OvernightStateItem[] = [];

  for (const issue of input.issues) {
    if (seen.has(issue)) {
      skipped.push(issue);
      continue;
    }
    seen.add(issue);

    const pf = await deps.preflight(issue);
    if (!pf.ok) {
      deps.log?.('overnight-preflight', `halted before issue #${issue}: ${pf.reason}`);
      return { processed, skipped, halted: { issue, reason: pf.reason }, statePath: input.statePath };
    }

    let outcome: OvernightItemOutcome;
    try {
      outcome = await deps.processItem(issue);
    } catch (err) {
      outcome = { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
    }

    const item: OvernightStateItem = {
      issue,
      status: outcome.status,
      reason: outcome.reason,
      finishedAt: now().toISOString(),
    };
    state.items.push(item);
    processed.push(item);
    await persistState(input.statePath, state);

    if (item.status === 'parked' || item.status === 'failed') {
      await deps.report?.(item);
      deps.log?.(item.status === 'parked' ? 'overnight-park' : 'overnight-fail', `issue #${issue}: ${item.status}`);
      continue;
    }

    deps.log?.('overnight-ready', `issue #${issue}: ready`);
  }

  return { processed, skipped, statePath: input.statePath };
}

async function loadState(statePath: string, now: () => Date): Promise<OvernightQueueState> {
  try {
    const raw = await readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as OvernightQueueState;
    if (parsed.profile === 'local-small-overnight' && Array.isArray(parsed.items)) {
      return parsed;
    }
  } catch {
    // Missing file, unreadable JSON, or wrong shape — fall through to a fresh state.
  }
  return { profile: 'local-small-overnight', startedAt: now().toISOString(), items: [] };
}

async function persistState(statePath: string, state: OvernightQueueState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}
