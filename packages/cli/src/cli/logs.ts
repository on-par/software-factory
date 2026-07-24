// packages/cli/src/cli/logs.ts — `factory logs` [--follow] [--json] [--issue <n>]

import type { FactoryEvent } from '@on-par/factory-core';
import { followEvents, readEvents } from '@on-par/factory-core';
import { colorEnabled, formatEventLine } from '@on-par/factory-core/internal';

export interface LogsOptions {
  follow?: boolean;
  json?: boolean;
  issue?: string;
}

export interface LogsDeps {
  out?: { write(s: string): unknown; isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
  /** Poll interval for --follow; tests pass ~10. Default 250 (satisfies the <1 s AC). */
  pollMs?: number;
}

export function eventMatchesIssue(e: FactoryEvent, issue?: string): boolean {
  return !issue || e.issue === issue;
}

export function renderEvent(e: FactoryEvent, opts: { json?: boolean; color: boolean }): string {
  if (opts.json) return JSON.stringify(e);
  return formatEventLine(e.type, e.issue, e.msg, { color: opts.color, lane: e.lane });
}

/** Print current events; with follow, keep tailing. Returns a stop() function (no-op stop for non-follow). */
export function runLogs(eventsFile: string, opts: LogsOptions, deps: LogsDeps = {}): () => void {
  const out = deps.out ?? process.stdout;
  const env = deps.env ?? process.env;
  const color = colorEnabled(out, env) && !opts.json;

  const emit = (e: FactoryEvent): void => {
    if (!eventMatchesIssue(e, opts.issue)) return;
    out.write(renderEvent(e, { json: opts.json, color }) + '\n');
  };

  if (!opts.follow) {
    for (const e of readEvents(eventsFile)) emit(e);
    return () => {};
  }

  return followEvents(eventsFile, emit, { fromStart: true, pollMs: deps.pollMs ?? 250 });
}

/** Command entry point wired up to commander. Keeps the process alive until Ctrl-C in --follow mode. */
export async function cmdLogs(opts: LogsOptions, deps: { eventsFile: string } & LogsDeps): Promise<void> {
  const stop = runLogs(deps.eventsFile, opts, deps);

  if (!opts.follow) return;

  const keepAlive = setInterval(() => {}, 60_000);
  await new Promise<void>((res) => {
    const done = () => res();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  stop();
  clearInterval(keepAlive);
}
