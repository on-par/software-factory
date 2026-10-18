// packages/cli/src/cli/logs.ts — `factory logs` [--follow] [--json] [--issue <n>] [--limit <n>] [--since <cursor>]

import type { FactoryEvent } from '@on-par/factory-core';
import { followEvents, readEvents } from '@on-par/factory-core';
import {
  InvalidEventCursorError,
  colorEnabled,
  formatEventLine,
  readEventsSince,
  readEventsTail,
} from '@on-par/factory-core/internal';

export interface LogsOptions {
  follow?: boolean;
  json?: boolean;
  issue?: string;
  /** Newest N matching events (oldest first); with `since`, the first N after the cursor. */
  limit?: number;
  /** Only events after this cursor (the `cursor` field of a previous --json line). */
  since?: string;
}

export interface LogsDeps {
  out?: { write(s: string): unknown; isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
  /** Poll interval for --follow; tests pass ~10. Default 250 (satisfies the <1 s AC). */
  pollMs?: number;
  /** Where cmdLogs writes JSON errors (default process.stderr). */
  err?: { write(s: string): unknown };
  /** Test hook: bytes read from the log by --limit/--since. */
  onBytesRead?: (n: number) => void;
}

export function eventMatchesIssue(e: FactoryEvent, issue?: string): boolean {
  return !issue || e.issue === issue;
}

export function renderEvent(e: FactoryEvent, opts: { json?: boolean; color: boolean }): string {
  if (opts.json) return JSON.stringify(e);
  return formatEventLine(e.type, e.issue, e.msg, { color: opts.color, lane: e.lane, ts: e.ts });
}

/** Print current events; with follow, keep tailing. Returns a stop() function (no-op stop for non-follow). */
export function runLogs(eventsFile: string, opts: LogsOptions, deps: LogsDeps = {}): () => void {
  const out = deps.out ?? process.stdout;
  const env = deps.env ?? process.env;
  const color = colorEnabled(out, env) && !opts.json;

  const { limit, since } = opts;
  const match = (e: FactoryEvent): boolean => eventMatchesIssue(e, opts.issue);
  const readOpts = { match, onBytesRead: deps.onBytesRead };
  const page =
    since !== undefined
      ? readEventsSince(eventsFile, since, { ...readOpts, limit })
      : limit !== undefined
        ? readEventsTail(eventsFile, { ...readOpts, limit })
        : undefined;
  if (page) {
    for (const { event, cursor } of page.events) {
      out.write((opts.json ? JSON.stringify({ ...event, cursor }) : renderEvent(event, { json: false, color })) + '\n');
    }
    if (!opts.follow) return () => {};
    return followEvents(
      eventsFile,
      (e) => {
        if (eventMatchesIssue(e, opts.issue)) out.write(renderEvent(e, { json: opts.json, color }) + '\n');
      },
      { startOffset: page.endOffset, pollMs: deps.pollMs ?? 250 },
    );
  }

  let delivered = 0;
  const emit = (e: FactoryEvent): void => {
    delivered++;
    if (!eventMatchesIssue(e, opts.issue)) return;
    out.write(renderEvent(e, { json: opts.json, color }) + '\n');
  };

  if (!opts.follow) {
    for (const e of readEvents(eventsFile)) emit(e);
    return () => {};
  }

  const stopTailing = followEvents(eventsFile, emit, { fromStart: true, pollMs: deps.pollMs ?? 250 });
  return () => {
    stopTailing();
    // Catch up on anything written in the poll window right before stop() (e.g. a
    // Ctrl-C racing the final "build complete" event) so it isn't silently dropped.
    for (const e of readEvents(eventsFile).slice(delivered)) emit(e);
  };
}

/** Command entry point wired up to commander. Keeps the process alive until Ctrl-C in --follow mode. */
export async function cmdLogs(opts: LogsOptions, deps: { eventsFile: string } & LogsDeps): Promise<void> {
  const errOut = deps.err ?? process.stderr;
  const fail = (error: string, message: string): void => {
    errOut.write(JSON.stringify({ error, message }) + '\n');
    process.exitCode = 1;
  };
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    fail('invalid-limit', `--limit must be a positive integer, got ${opts.limit}`);
    return;
  }

  let stop: () => void;
  try {
    stop = runLogs(deps.eventsFile, opts, deps);
  } catch (e) {
    if (e instanceof InvalidEventCursorError) {
      fail(e.code, e.message);
      return;
    }
    throw e;
  }

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
