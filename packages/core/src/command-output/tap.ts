// src/command-output/tap.ts — one output tap per command, fanning out to the raw NDJSON file sink
// (FACTORY_COMMAND_STREAM_DIR) and the redacted OTLP sink (FACTORY_COMMAND_OUTPUT_EXPORT=otlp), plus the session
// lifecycle the CLI drives. With both off, no tap exists and the runners behave exactly as without this module.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Readable } from 'node:stream';

import {
  type CommandStreamEnd,
  type CommandStreamSink,
  openCommandStream,
  startCommandStreamSession,
} from './file-sink.js';
import type { OtlpSessionSummary, OtlpSink } from './otlp-sink.js';
import { nextCommandId, warnOnce } from './state.js';

/** Set to `otlp` on the factory process to export nested command output as OTLP log records. */
const COMMAND_OUTPUT_EXPORT_ENV = 'FACTORY_COMMAND_OUTPUT_EXPORT';
/** How long a detached run waits for its stdio to drain after exit before ending the tap. */
const DRAIN_GRACE_MS = 250;
/** Flush budget on normal CLI completion. */
const EXIT_FLUSH_BUDGET_MS = 5_000;

const modelOutput = new AsyncLocalStorage<true>();
let otlp: OtlpSink | undefined;
let closing: Promise<OtlpSessionSummary | undefined> | undefined;
const draining = new Set<Promise<void>>();

/** Runs `fn` as a model execution: commands it starts are never exported over OTLP (ADR-0145's no-model-content
 *  rule). The harness layer sets this once around every agent CLI exec. */
export function withModelOutput<T>(fn: () => T): T {
  return modelOutput.run(true, fn);
}

/** Starts this CLI process's command output session: the NDJSON session files when the stream dir is set, and
 *  the OTLP sink when `FACTORY_COMMAND_OUTPUT_EXPORT=otlp` and standard OTel env configure an endpoint. A host
 *  that sets `OTEL_*` only for other reasons gets no export. Never throws. */
export async function startCommandOutputSession(opts: { version: string }): Promise<void> {
  startCommandStreamSession(opts);
  const wanted = process.env[COMMAND_OUTPUT_EXPORT_ENV]?.trim();
  if (!wanted || otlp) return;
  if (wanted !== 'otlp') {
    warnOnce(`factory: command output export off: ${COMMAND_OUTPUT_EXPORT_ENV}='${wanted}' is not 'otlp'`);
    return;
  }
  try {
    const { createOtlpSink, resolveOtlpActivation } = await import('./otlp-sink.js');
    const activation = resolveOtlpActivation();
    if (!activation.enabled) {
      if (activation.warning) warnOnce(activation.warning);
      return;
    }
    otlp = await createOtlpSink({ version: opts.version, protocol: activation.protocol });
  } catch (err) {
    warnOnce(`factory: command output export unavailable: ${(err as Error).message}`);
  }
}

/** Opens the tap for one command, or returns undefined when no sink is on. Methods never throw. */
export function openCommandOutput(
  argv: readonly string[],
  opts: { cwd?: string; shell?: boolean } = {},
): CommandStreamSink | undefined {
  const file = openCommandStream(argv, opts);
  let remote: CommandStreamSink | undefined;
  if (otlp && !closing) {
    if (modelOutput.getStore()) otlp.countWithheld();
    else remote = otlp.openCommand(file?.id ?? nextCommandId(), argv, opts);
  }
  if (!remote) return file;
  if (!file) return remote;
  const both = [file, remote];
  return {
    write: (stream, chunk) => both.forEach((s) => s.write(stream, chunk)),
    end: (result) => both.forEach((s) => s.end(result)),
  };
}

/** Ends the tap once both pipes have closed, or after a short grace when a backgrounded grandchild keeps them
 *  open. Never delays the caller: the end can land just after the runner returns. */
export function endCommandOutputWhenDrained(
  tap: CommandStreamSink,
  pipes: readonly (Readable | null | undefined)[],
  result: CommandStreamEnd,
): void {
  const open = pipes.filter((p): p is Readable => !!p && !p.readableEnded && !p.destroyed);
  if (open.length === 0) {
    tap.end(result);
    return;
  }
  let pending = open.length;
  let resolveDrained = () => {};
  const drained = new Promise<void>((r) => (resolveDrained = r));
  draining.add(drained);
  const done = () => {
    clearTimeout(timer);
    draining.delete(drained);
    tap.end(result);
    resolveDrained();
  };
  const timer = setTimeout(done, DRAIN_GRACE_MS);
  timer.unref();
  for (const pipe of open)
    pipe.once('close', () => {
      if (--pending === 0) done();
    });
}

/** Ends the OTLP session: commands still running are ended as interrupted, a session end record with totals is
 *  queued, and the queue is flushed within `budgetMs`. Resolves undefined when export is off. A summary that is
 *  not complete prints one warning. */
export function closeCommandOutputSession(
  reason: 'exit' | 'signal' | 'error',
  budgetMs: number = EXIT_FLUSH_BUDGET_MS,
): Promise<OtlpSessionSummary | undefined> {
  const sink = otlp;
  if (!sink) return closing ?? Promise.resolve(undefined);
  closing ??= (async () => {
    // Ref'd for the bounded close only, so the process cannot exit while the flush is still within budget.
    const keepAlive = setTimeout(() => {}, budgetMs + DRAIN_GRACE_MS);
    try {
      await Promise.all(draining);
      const summary = await sink.close(reason, budgetMs);
      if (!summary.complete)
        warnOnce(
          `factory: command output export incomplete: dropped=${summary.dropped} failed=${summary.exportFailed} ` +
            `unsent=${summary.unsent} interrupted=${summary.interrupted}`,
        );
      return summary;
    } finally {
      clearTimeout(keepAlive);
      otlp = undefined;
    }
  })().finally(() => {
    closing = undefined;
  });
  return closing;
}
