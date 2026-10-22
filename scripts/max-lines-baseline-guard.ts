// scripts/max-lines-baseline-guard.ts — CI guard: raising or adding a max-lines-baseline.json
// entry needs the max-lines:override label applied by a human (#3466).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MAX_LINES_OVERRIDE_DOCS, MAX_LINES_OVERRIDE_LABEL } from './max-lines-baseline.js';

export interface BaselineDiff {
  raised: { path: string; base: number; head: number }[];
  added: { path: string; head: number }[];
  lowered: { path: string; base: number; head: number }[];
  removed: { path: string; base: number }[];
}

export interface LabelEvent {
  event: string;
  label?: { name: string };
  actor?: { login: string; type?: string } | null;
}

export type OverrideVerdict = { kind: 'absent' } | { kind: 'human'; actor: string } | { kind: 'bot'; actor: string };

export interface GuardIo {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  git?: (args: readonly string[]) => string;
  readHead?: () => string;
  fetchLabelEvents?: (repo: string, pr: number) => LabelEvent[];
  log?: (line: string) => void;
  error?: (line: string) => void;
}

const BASELINE_FILE = 'max-lines-baseline.json';
const USAGE = 'usage: max-lines-baseline-guard.ts --base <sha> --pr <number>';

export function diffMaxLinesBaseline(
  base: Readonly<Record<string, number>>,
  head: Readonly<Record<string, number>>,
): BaselineDiff {
  const diff: BaselineDiff = { raised: [], added: [], lowered: [], removed: [] };
  for (const [path, count] of Object.entries(head)) {
    const before = base[path];
    if (before === undefined) diff.added.push({ path, head: count });
    else if (count > before) diff.raised.push({ path, base: before, head: count });
    else if (count < before) diff.lowered.push({ path, base: before, head: count });
  }
  for (const [path, count] of Object.entries(base)) {
    if (head[path] === undefined) diff.removed.push({ path, base: count });
  }
  return diff;
}

export function isBotActor(actor: { login: string; type?: string }, botLogins: readonly string[]): boolean {
  const login = actor.login.toLowerCase();
  if (actor.type === 'Bot' || login.endsWith('[bot]')) return true;
  return botLogins.some((entry) => {
    const name = entry.trim().toLowerCase();
    return name !== '' && name === login;
  });
}

export function overrideLabelVerdict(events: readonly LabelEvent[], botLogins: readonly string[]): OverrideVerdict {
  const last = events.findLast(
    (e) => (e.event === 'labeled' || e.event === 'unlabeled') && e.label?.name === MAX_LINES_OVERRIDE_LABEL,
  );
  if (!last || last.event === 'unlabeled' || !last.actor) return { kind: 'absent' };
  return { kind: isBotActor(last.actor, botLogins) ? 'bot' : 'human', actor: last.actor.login };
}

function entryLines(diff: BaselineDiff): string[] {
  return [
    ...diff.raised.map((r) => `${BASELINE_FILE} raised ${r.path} from ${r.base} to ${r.head}`),
    ...diff.added.map((a) => `${BASELINE_FILE} added ${a.path} at ${a.head}`),
  ];
}

export function renderGuardFailure(diff: BaselineDiff, verdict: OverrideVerdict): string[] {
  const lines = entryLines(diff);
  if (verdict.kind === 'bot') {
    lines.push(
      `${MAX_LINES_OVERRIDE_LABEL} was applied by bot identity ${verdict.actor}; the label must be applied by a human`,
    );
  } else {
    lines.push(
      `raising or adding a ${BASELINE_FILE} entry needs the ${MAX_LINES_OVERRIDE_LABEL} label applied by a human`,
    );
  }
  lines.push(`split the file instead, or see ${MAX_LINES_OVERRIDE_DOCS}`);
  return lines;
}

function parseArgs(argv: readonly string[]): { base: string; pr: number } | undefined {
  const [baseFlag, base, prFlag, pr, ...rest] = argv;
  if (baseFlag !== '--base' || prFlag !== '--pr' || !base || !pr || rest.length > 0) return undefined;
  const number = Number(pr);
  return Number.isInteger(number) && number > 0 ? { base, pr: number } : undefined;
}

function parseBaseline(text: string, label: string): Record<string, number> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} ${BASELINE_FILE} must be a JSON object`);
  }
  const out: Record<string, number> = {};
  for (const [path, count] of Object.entries(value)) {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
      throw new Error(`${label} ${BASELINE_FILE} entry ${path} must be a finite number`);
    }
    out[path] = count;
  }
  return out;
}

function defaultFetchLabelEvents(repo: string, pr: number): LabelEvent[] {
  const out = execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/events`], {
    encoding: 'utf8',
  });
  const pages: unknown = JSON.parse(out);
  return (Array.isArray(pages) ? pages.flat() : []) as LabelEvent[];
}

export function runMaxLinesBaselineGuard(argv: readonly string[], io: GuardIo = {}): number {
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  const args = parseArgs(argv);
  if (!args) {
    error(USAGE);
    return 2;
  }
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const git = io.git ?? ((a: readonly string[]) => execFileSync('git', [...a], { cwd, encoding: 'utf8' }));
  const readHead = io.readHead ?? (() => readFileSync(resolve(cwd, BASELINE_FILE), 'utf8'));
  let diff: BaselineDiff;
  try {
    let baseText = '{}';
    try {
      baseText = git(['show', `${args.base}:${BASELINE_FILE}`]);
    } catch {
      // The baseline did not exist at the base ref: every head entry counts as added.
    }
    diff = diffMaxLinesBaseline(parseBaseline(baseText, 'base'), parseBaseline(readHead(), 'head'));
  } catch (err) {
    error(`max-lines baseline guard: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (diff.raised.length === 0 && diff.added.length === 0) {
    log(
      `max-lines baseline guard: no raised or added entries (${diff.lowered.length} lowered, ${diff.removed.length} removed)`,
    );
    return 0;
  }
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) {
    error('max-lines baseline guard: GITHUB_REPOSITORY is not set');
    return 1;
  }
  let verdict: OverrideVerdict;
  try {
    const events = (io.fetchLabelEvents ?? defaultFetchLabelEvents)(repo, args.pr);
    verdict = overrideLabelVerdict(events, (env.MAX_LINES_BOT_LOGINS ?? '').split(','));
  } catch (err) {
    error(
      `max-lines baseline guard: could not read PR label events: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  if (verdict.kind === 'human') {
    const lines = entryLines(diff);
    log(
      `max-lines baseline guard: ${lines.length} raised/added entr${lines.length === 1 ? 'y' : 'ies'} approved by ${verdict.actor} via ${MAX_LINES_OVERRIDE_LABEL}`,
    );
    for (const line of lines) log(line);
    return 0;
  }
  for (const line of renderGuardFailure(diff, verdict)) error(line);
  return 1;
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  process.exitCode = runMaxLinesBaselineGuard(process.argv.slice(2));
}
