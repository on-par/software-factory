// packages/core/src/command-output/capture.ts — correlated live capture of nested command output (#3994)
import { AsyncLocalStorage } from 'node:async_hooks';

import { createStreamRedactor } from './redactor.js';

export type CommandOutputStream = 'stdout' | 'stderr';

export interface CommandOutputCorrelation {
  runId: string;
  issue: string;
  lane: string;
  phase: string;
}

export interface CommandOutputRecord extends CommandOutputCorrelation {
  commandId: string;
  seq: number;
  stream: CommandOutputStream;
  text: string;
  time: string;
}

export type CommandOutputSink = (record: CommandOutputRecord) => void;

export interface CommandCapture {
  commandId: string;
  onChunk(stream: CommandOutputStream, chunk: Buffer | string): void;
  close(): void;
}

interface Scope {
  correlation: CommandOutputCorrelation;
  nextCommand: number;
}

const storage = new AsyncLocalStorage<Scope>();
const sinks = new Set<CommandOutputSink>();

export function withCommandOutputScope<T>(correlation: CommandOutputCorrelation, fn: () => Promise<T>): Promise<T> {
  return storage.run({ correlation, nextCommand: 0 }, fn);
}

export function registerCommandOutputSink(sink: CommandOutputSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/** Opens a capture for one command; undefined outside a scope or when no sink is registered. */
export function openCommandCapture(
  options: { env?: Record<string, string | undefined>; now?: () => Date } = {},
): CommandCapture | undefined {
  const store = storage.getStore();
  if (!store || sinks.size === 0) return undefined;
  const commandId = `cmd-${store.nextCommand++}`;
  const now = options.now ?? (() => new Date());
  const redactors = {
    stdout: createStreamRedactor({ env: options.env }),
    stderr: createStreamRedactor({ env: options.env }),
  };
  let seq = 0;
  let closed = false;

  const emit = (stream: CommandOutputStream, lines: string[]): void => {
    for (const text of lines) {
      const record: CommandOutputRecord = {
        ...store.correlation,
        commandId,
        seq: seq++,
        stream,
        text,
        time: now().toISOString(),
      };
      for (const sink of sinks) {
        try {
          sink(record);
        } catch {
          // a sink failure must never reach the command
        }
      }
    }
  };

  return {
    commandId,
    onChunk(stream, chunk) {
      if (closed) return;
      emit(stream, redactors[stream].push(chunk));
    },
    close() {
      if (closed) return;
      closed = true;
      emit('stdout', redactors.stdout.end());
      emit('stderr', redactors.stderr.end());
    },
  };
}
