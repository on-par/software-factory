import type { CodexRolloutUsage } from './codex-cli.js';
import type { HarnessLiveUsage } from './index.js';

export const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CODEX_LIVE_USAGE_INTERVAL_MS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function codexThreadIdFromStdout(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    let value: unknown;
    try {
      value = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (!isRecord(value) || value.type !== 'thread.started' || typeof value.thread_id !== 'string') continue;
    if (CODEX_THREAD_ID.test(value.thread_id)) return value.thread_id;
  }
  return undefined;
}

export interface CodexLiveUsageOptions {
  onUsage: (cumulative: HarnessLiveUsage) => void;
  codexHome?: string;
  /** Poll interval; default 5000. */
  intervalMs?: number;
  locate: (threadId: string, codexHome?: string) => Promise<string | undefined>;
  read: (path: string) => Promise<CodexRolloutUsage | undefined>;
}

function sumUsage(usage: CodexRolloutUsage): HarnessLiveUsage {
  const { calls } = usage;
  const hasCache = calls.some((call) => call.cacheReadTokens !== undefined);
  return {
    inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
    outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
    rawInputTokens: calls.reduce((sum, call) => sum + (call.rawInputTokens ?? 0), 0),
    ...(hasCache ? { cacheReadTokens: calls.reduce((sum, call) => sum + (call.cacheReadTokens ?? 0), 0) } : {}),
    calls: calls.length,
    numTurns: usage.numTurns,
    peakInputTokens: usage.peakInputTokens,
    ...(usage.contextWindow !== undefined ? { contextWindow: usage.contextWindow } : {}),
  };
}

/** Poll the live Codex session rollout and report cumulative usage whenever new calls appear (#3319). */
export function startCodexLiveUsage(options: CodexLiveUsageOptions): {
  onStdout: (chunk: string) => void;
  stop: () => void;
} {
  const { onUsage, codexHome, locate, read } = options;
  let buffer = '';
  let threadId: string | undefined;
  let rolloutPath: string | undefined;
  let reported = 0;
  let inFlight = false;
  let stopped = false;

  const onStdout = (chunk: string): void => {
    if (stopped || threadId !== undefined) return;
    const lines = (buffer + chunk).split('\n');
    buffer = lines.pop() ?? '';
    const found = codexThreadIdFromStdout(lines.join('\n'));
    if (found !== undefined) {
      threadId = found;
      buffer = '';
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped || inFlight || threadId === undefined) return;
    inFlight = true;
    try {
      rolloutPath ??= await locate(threadId, codexHome);
      if (rolloutPath === undefined) return;
      const usage = await read(rolloutPath);
      if (stopped || !usage || usage.calls.length <= reported) return;
      reported = usage.calls.length;
      onUsage(sumUsage(usage));
    } catch {
      // missing rollout, failed read or throwing callback: skip this tick
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? CODEX_LIVE_USAGE_INTERVAL_MS);
  timer.unref();

  return {
    onStdout,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
