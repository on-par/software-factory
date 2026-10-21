// packages/cli/src/cli/steer.ts — `factory steer <ref>`: append a human or bot steer to a run (#3401).
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendSteerEvent,
  readIssueRunState,
  runStateFile,
  STEER_PHASES,
  STEER_SOURCES,
  SteerEventError,
  writeIssueRunState,
  type IssueRunState,
  type RunStatus,
  type SteerEvent,
  type SteerPhase,
  type SteerSource,
} from '@on-par/factory-core/internal';
import { getFactoryPaths } from '@on-par/factory-core';

import type { CliExitError } from './index.js';

export type SteerRef = { kind: 'issue' | 'pr' | 'any'; number: number; raw: string };

export interface SteerOptions {
  message?: string;
  source?: string;
  phase?: string;
  actor?: string;
  unblocked?: boolean;
}

export interface SteerDeps {
  runsDir: string;
  now: () => string;
  defaultActor: () => string;
}

export interface SteerResult {
  issue: number;
  file: string;
  event: SteerEvent;
}

export class SteerCliError extends Error {
  constructor(
    message: string,
    readonly code: 'bad-input' | 'no-run',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SteerCliError';
  }
}

export function parseSteerRef(raw: string): SteerRef {
  const text = raw.trim();
  const found: [SteerRef['kind'], RegExpMatchArray | null][] = [
    ['any', text.match(/^#?(\d+)$/)],
    ['issue', text.match(/\/issues\/(\d+)\/?$/)],
    ['pr', text.match(/\/pull\/(\d+)\/?$/)],
  ];
  for (const [kind, match] of found) {
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n >= 1) return { kind, number: n, raw };
    break;
  }
  throw new SteerCliError(
    `invalid reference '${raw}' — expected an issue or PR number (42, #42) or a GitHub issue/pull URL`,
    'bad-input',
  );
}

export async function resolveSteerRun(runsDir: string, ref: SteerRef): Promise<{ file: string; state: IssueRunState }> {
  if (ref.kind !== 'pr') {
    const file = runStateFile(runsDir, ref.number);
    const state = await readIssueRunState(file);
    if (state) return { file, state };
  }
  if (ref.kind !== 'issue') {
    let names: string[];
    try {
      names = await readdir(runsDir);
    } catch {
      names = [];
    }
    for (const name of names.filter((n) => /^issue-(\d+)\.json$/.test(n)).sort()) {
      const file = join(runsDir, name);
      const state = await readIssueRunState(file);
      if (state?.prNumber === ref.number) return { file, state };
    }
  }
  throw new SteerCliError(`no run found for ${ref.raw}`, 'no-run');
}

export function phaseForStatus(status: RunStatus): SteerPhase | null {
  switch (status) {
    case 'pending':
    case 'planning':
      return 'plan';
    case 'building':
    case 'reworking':
      return 'build';
    case 'checking':
      return 'check';
    case 'shipping':
    case 'ready':
    case 'awaiting-review':
    case 'merged':
      return 'ship';
    case 'parked':
    case 'escalated':
    case 'failed':
      return null;
  }
}

function requireMessage(opts: SteerOptions): string {
  const message = opts.message?.trim() ?? '';
  if (message === '') throw new SteerCliError('--message must not be empty', 'bad-input');
  return message;
}

export function buildSteerEvent(
  state: IssueRunState,
  opts: SteerOptions,
  deps: Pick<SteerDeps, 'now' | 'defaultActor'>,
): SteerEvent {
  const message = requireMessage(opts);
  const rawSource = opts.source ?? 'cli';
  const source = STEER_SOURCES.find((s): s is SteerSource => s === rawSource);
  if (!source) {
    throw new SteerCliError(
      `invalid --source '${rawSource}' — expected one of ${STEER_SOURCES.join(', ')}`,
      'bad-input',
    );
  }
  if (source === 'bot' && !opts.actor?.trim()) throw new SteerCliError('--source bot needs --actor <id>', 'bad-input');
  let phase: SteerPhase | null;
  if (opts.phase !== undefined) {
    const given = opts.phase;
    phase = STEER_PHASES.find((p): p is SteerPhase => p === given) ?? null;
    if (!phase) {
      throw new SteerCliError(`invalid --phase '${given}' — expected one of ${STEER_PHASES.join(', ')}`, 'bad-input');
    }
  } else {
    phase = phaseForStatus(state.status);
  }
  if (!phase) {
    throw new SteerCliError(
      `run #${state.issue} is ${state.status}; pass --phase ${STEER_PHASES.join('|')}`,
      'bad-input',
    );
  }
  const actor = opts.actor?.trim() || deps.defaultActor();
  return { ts: deps.now(), actor, source, phase, summary: message, ...(opts.unblocked ? { unblocked: true } : {}) };
}

export async function runSteer(rawRef: string, opts: SteerOptions, deps: SteerDeps): Promise<SteerResult> {
  const ref = parseSteerRef(rawRef);
  requireMessage(opts);
  const { file, state } = await resolveSteerRun(deps.runsDir, ref);
  const event = buildSteerEvent(state, opts, deps);
  let next: IssueRunState;
  try {
    next = appendSteerEvent(state, event);
  } catch (err) {
    if (err instanceof SteerEventError) throw new SteerCliError(err.message, 'bad-input', { cause: err });
    throw err;
  }
  await writeIssueRunState(file, next);
  return { issue: state.issue, file, event };
}

/** What `factory steer` needs from the CLI entry point; index.ts binds it. */
export interface SteerRuntime {
  getRepoRoot: () => Promise<string>;
  /** `git config user.name`; a rejection or blank result falls back to $USER, then 'unknown'. */
  gitUserName: () => Promise<string>;
  env: Record<string, string | undefined>;
  now: () => string;
  CliExitError: typeof CliExitError;
  errorDetail: (err: unknown) => string;
  log: (line: string) => void;
}

/** `factory steer <ref>`: bad input exits 2, no matching run exits 1, anything else exits 1 with its detail. */
export async function cmdSteer(ref: string, opts: SteerOptions, rt: SteerRuntime): Promise<void> {
  let result: SteerResult;
  try {
    parseSteerRef(ref); // a bad <ref> exits 2 before any git lookup
    const gitUser = (await rt.gitUserName().catch(() => '')).trim();
    result = await runSteer(ref, opts, {
      runsDir: getFactoryPaths(await rt.getRepoRoot()).runs,
      now: rt.now,
      defaultActor: () => gitUser || rt.env.USER || 'unknown',
    });
  } catch (err) {
    if (err instanceof SteerCliError) {
      throw new rt.CliExitError(`factory: steer — ${err.message}`, err.code === 'no-run' ? 1 : 2);
    }
    throw new rt.CliExitError(`factory: steer failed — ${rt.errorDetail(err)}`, 1);
  }
  rt.log(
    `factory: steer recorded on #${result.issue} (source ${result.event.source}, phase ${result.event.phase}, actor ${result.event.actor})`,
  );
}
