import type { TaskType } from '../types/index.js';
import { taskRequiresAgenticHarness } from './index.js';

/** Packaged default Codex auto-compact token limit for agentic build sessions (#3326). */
export const DEFAULT_CODEX_CONTEXT_CEILING = 120_000;

export type CodexContextCeiling = { on: true; limit: number } | { on: false; why: string };

/** Decides whether a Codex run gets an auto-compact limit; only agentic build tasks are eligible. */
export function resolveCodexContextCeiling(
  task: TaskType,
  requested: number | undefined,
  contextWindow: number | undefined,
): CodexContextCeiling {
  if (!taskRequiresAgenticHarness(task)) return { on: false, why: 'not an agentic build task' };
  const n = requested ?? DEFAULT_CODEX_CONTEXT_CEILING;
  if (n === 0) return { on: false, why: 'contextCeiling 0' };
  if (!Number.isInteger(n) || n < 0) return { on: false, why: `invalid contextCeiling ${n}` };
  if (contextWindow !== undefined && n >= contextWindow) {
    return { on: false, why: `ceiling ${n} >= context window ${contextWindow}` };
  }
  return { on: true, limit: n };
}

/** Handoff instruction Codex uses instead of its built-in summary prompt when it auto-compacts. */
export const CODEX_COMPACT_PROMPT = `You are summarizing an in-progress factory BUILD session so a fresh context can continue it.
Write a handoff that keeps:
- the spec path (.factory/state/plans/issue-<n>.md) and its design: block (approach, files, signatures)
- the acceptance criteria still open versus done
- the commits made so far (git log --oneline since the base)
- the latest git status --short and git diff --stat output
- the next step, and any failing command with its key error line
Name file paths and say to re-read them; do not quote file contents.`;
