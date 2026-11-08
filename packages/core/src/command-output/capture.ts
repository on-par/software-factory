// src/command-output/capture.ts — live capture of nested checker/verify command output.
// Model output never enters this path (ADR-0145): only runVerificationCommand and the
// app_smoke app boot open a capture; harness exec does not.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { createLineRedactor } from './redact-stream.js';

export type CommandOutputStream = 'stdout' | 'stderr';

export interface CommandOutputCorrelation {
  runId: string | null;
  issue: string;
  laneId: string | null;
  phase: string;
}

export interface CommandOutputRecord extends CommandOutputCorrelation {
  commandId: string;
  seq: number;
  stream: CommandOutputStream;
  text: string;
  /** ISO time. */
  ts: string;
}

export type CommandOutputSink = (record: CommandOutputRecord) => void;

export interface CommandCapture {
  readonly commandId: string;
  write(stream: CommandOutputStream, chunk: Uint8Array): void;
  end(): void;
}

const sinks = new Set<CommandOutputSink>();
const scope = new AsyncLocalStorage<CommandOutputCorrelation>();

export function addCommandOutputSink(sink: CommandOutputSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

export function withCommandOutputCapture<T>(correlation: CommandOutputCorrelation, fn: () => T): T {
  return scope.run(correlation, fn);
}

/** Undefined outside a capture scope or with no sink registered, so it adds no work. */
export function openCommandCapture(): CommandCapture | undefined {
  const correlation = scope.getStore();
  if (correlation === undefined || sinks.size === 0) return undefined;
  const commandId = randomUUID();
  let seq = 0;
  let ended = false;
  const redactorFor = (stream: CommandOutputStream) =>
    createLineRedactor((text) => {
      const record: CommandOutputRecord = {
        ...correlation,
        commandId,
        seq: seq++,
        stream,
        text,
        ts: new Date().toISOString(),
      };
      for (const sink of Array.from(sinks)) {
        try {
          sink(record);
        } catch {
          // a throwing sink must not stop the others
        }
      }
    });
  const redactors = { stdout: redactorFor('stdout'), stderr: redactorFor('stderr') };
  return {
    commandId,
    write(stream, chunk) {
      if (ended) return;
      redactors[stream].write(chunk);
    },
    end() {
      if (ended) return;
      ended = true;
      redactors.stdout.end();
      redactors.stderr.end();
    },
  };
}
