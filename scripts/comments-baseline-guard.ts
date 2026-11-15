import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { diffMaxLinesBaseline, type BaselineDiff } from './max-lines-baseline-guard.js';

export interface CommentsGuardIo {
  cwd?: string;
  git?: (args: readonly string[]) => string;
  readHead?: () => string;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

const BASELINE_FILE = 'comments-baseline.json';
const USAGE = 'usage: comments-baseline-guard.ts --base <sha>';

export function renderCommentsGuardFailure(diff: BaselineDiff): string[] {
  return [
    ...diff.raised.map((r) => `raised ${r.path} from ${r.base} to ${r.head}`),
    ...diff.added.map((a) => `added ${a.path} at ${a.head}`),
    `${BASELINE_FILE} entries may only be lowered or removed; delete comments instead (see .claude/skills/verify/SKILL.md#comments-baseline)`,
  ];
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

export function runCommentsBaselineGuard(argv: readonly string[], io: CommentsGuardIo = {}): number {
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  const [flag, base, ...rest] = argv;
  if (flag !== '--base' || !base || rest.length > 0) {
    error(USAGE);
    return 2;
  }
  const cwd = io.cwd ?? process.cwd();
  const git = io.git ?? ((a: readonly string[]) => execFileSync('git', [...a], { cwd, encoding: 'utf8' }));
  const readHead = io.readHead ?? (() => readFileSync(resolve(cwd, BASELINE_FILE), 'utf8'));
  let diff: BaselineDiff;
  try {
    if (git(['ls-tree', base, '--', BASELINE_FILE]).trim() === '') {
      parseBaseline(readHead(), 'head');
      log(`comments baseline guard: ${BASELINE_FILE} is new at the base ref; nothing to compare`);
      return 0;
    }
    diff = diffMaxLinesBaseline(
      parseBaseline(git(['show', `${base}:${BASELINE_FILE}`]), 'base'),
      parseBaseline(readHead(), 'head'),
    );
  } catch (err) {
    error(`comments baseline guard: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (diff.raised.length === 0 && diff.added.length === 0) {
    log(
      `comments baseline guard: no raised or added entries (${diff.lowered.length} lowered, ${diff.removed.length} removed)`,
    );
    return 0;
  }
  for (const line of renderCommentsGuardFailure(diff)) error(line);
  return 1;
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  process.exitCode = runCommentsBaselineGuard(process.argv.slice(2));
}
