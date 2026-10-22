import { resolveCodexContextCeiling } from '../harness/codex-context-ceiling.js';
import { taskRequiresAgenticHarness } from '../harness/index.js';
import type { TaskType } from '../types/index.js';

/** Harness ids that honour HarnessRequest.contextCeiling; others get their own wiring later (#3327). */
export const CONTEXT_CEILING_HARNESSES: readonly string[] = ['codex-cli'];

export type ContextCeilingNotice = { task: TaskType; model: string; harness: string } & (
  { value: number } | { off: string }
);

/** The request ceiling for one attempt: set only for agentic build tasks on a harness that honours it. */
export function contextCeilingFor(
  task: TaskType,
  harnessId: string | undefined,
  ceilings: Readonly<Record<string, number>>,
): number | undefined {
  if (harnessId === undefined || !taskRequiresAgenticHarness(task)) return undefined;
  if (!CONTEXT_CEILING_HARNESSES.includes(harnessId)) return undefined;
  return ceilings[harnessId];
}

/** What the harness will do with the ceiling, for the context_ceiling event. */
export function contextCeilingNotice(
  task: TaskType,
  model: string,
  harnessId: string | undefined,
  ceilings: Readonly<Record<string, number>>,
  contextWindow: number | undefined,
): ContextCeilingNotice {
  const harness = harnessId ?? 'unknown';
  if (harnessId === undefined || !CONTEXT_CEILING_HARNESSES.includes(harnessId)) {
    return { task, model, harness, off: `unsupported by ${harness}` };
  }
  const requested = contextCeilingFor(task, harnessId, ceilings);
  const r = resolveCodexContextCeiling(task, requested, contextWindow);
  if (r.on) return { task, model, harness, value: r.limit };
  return { task, model, harness, off: requested === 0 ? 'config' : r.why };
}

export function formatContextCeilingNotice(notice: ContextCeilingNotice): string {
  const who = `for ${notice.task} (${notice.harness}, ${notice.model})`;
  return 'value' in notice ? `context ceiling ${notice.value} ${who}` : `context ceiling off (${notice.off}) ${who}`;
}
