// src/command-output/otlp-sink.ts — the redacted OTLP log sink for nested command output. Loaded only when export
// is switched on, so the OTel packages never load on the disabled path. Each command's chunks are decoded,
// framed and redacted before they reach the bounded queue; the official exporter does the encoding and transport.

import { basename } from 'node:path';

import type { Attributes } from '@opentelemetry/api';
import {
  getBooleanFromEnv,
  getNumberFromEnv,
  getStringFromEnv,
  getStringListFromEnv,
  millisToHrTime,
} from '@opentelemetry/core';
import {
  defaultResource,
  detectResources,
  resourceAttributesEnvDetector,
  resourceFromAttributes,
  serviceNameEnvDetector,
} from '@opentelemetry/resources';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';

import {
  createExportQueue,
  type DeliveryAccount,
  newAccount,
  type QueueLimits,
  type RecordExporter,
  type RetryPolicy,
} from './export-queue.js';
import type { CommandStreamEnd, CommandStreamSink, OutputStream } from './file-sink.js';
import { createLineFramer, type OutputSegment } from './line-framer.js';
import { collectKnownSecrets, createRedactor } from './redactor.js';
import { PROCESS_TAG } from './state.js';

type OtlpProtocol = 'http/protobuf' | 'http/json';

/** Upper bound on one export call (the exporter's timeout, including its own retries), so a flush budget holds. */
const MAX_EXPORT_TIMEOUT_MS = 2_000;
/** Rough per-record overhead beyond the body, counted against the queue's byte bounds. */
const RECORD_OVERHEAD_BYTES = 160;
const SCOPE = { name: 'factory.command_output', version: '1' };

export type OtlpActivation = { enabled: true; protocol: OtlpProtocol } | { enabled: false; warning?: string };

/** Reads the standard OTel env once export has been requested: `OTEL_SDK_DISABLED=true` or `OTEL_LOGS_EXPORTER`
 *  without `otlp` turn it off; an endpoint must be configured; only the HTTP protocols are supported. */
export function resolveOtlpActivation(): OtlpActivation {
  if (getBooleanFromEnv('OTEL_SDK_DISABLED')) return { enabled: false };
  const exporters = getStringListFromEnv('OTEL_LOGS_EXPORTER') ?? ['otlp'];
  if (exporters.includes('none')) return { enabled: false };
  if (!exporters.includes('otlp'))
    return { enabled: false, warning: `factory: command output export disabled: OTEL_LOGS_EXPORTER has no 'otlp'` };
  if (!getStringFromEnv('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT') && !getStringFromEnv('OTEL_EXPORTER_OTLP_ENDPOINT'))
    return {
      enabled: false,
      warning:
        'factory: command output export disabled: no OTLP logs endpoint (set OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)',
    };
  const protocol =
    getStringFromEnv('OTEL_EXPORTER_OTLP_LOGS_PROTOCOL') ??
    getStringFromEnv('OTEL_EXPORTER_OTLP_PROTOCOL') ??
    'http/protobuf';
  if (protocol !== 'http/protobuf' && protocol !== 'http/json')
    return {
      enabled: false,
      warning: `factory: command output export disabled: unsupported OTLP protocol '${protocol}' (use http/protobuf or http/json)`,
    };
  return { enabled: true, protocol };
}

export interface OtlpSessionSummary {
  commands: number;
  /** Output records admitted to the queue. */
  records: number;
  acked: number;
  dropped: number;
  exportFailed: number;
  markersDropped: number;
  /** Commands whose output was not exported because they ran model executions. */
  withheld: number;
  /** Commands still running at close, ended as interrupted. */
  interrupted: number;
  /** Records still unacknowledged when the flush budget ran out. */
  unsent: number;
  retries: number;
  /** Every record was acknowledged, nothing was dropped or interrupted, and the session end was flushed. */
  complete: boolean;
}

export interface OtlpSink {
  openCommand(id: string, argv: readonly string[], opts: { cwd?: string; shell?: boolean }): CommandStreamSink;
  countWithheld(): void;
  close(reason: 'exit' | 'signal' | 'error', budgetMs: number): Promise<OtlpSessionSummary>;
}

async function createExporter(protocol: OtlpProtocol, timeoutMillis: number): Promise<RecordExporter> {
  const { OTLPLogExporter } =
    protocol === 'http/json'
      ? await import('@opentelemetry/exporter-logs-otlp-http')
      : await import('@opentelemetry/exporter-logs-otlp-proto');
  return new OTLPLogExporter({ timeoutMillis });
}

export async function createOtlpSink(opts: {
  version: string;
  protocol: OtlpProtocol;
  exporter?: RecordExporter;
  limits?: Partial<QueueLimits>;
  retry?: Partial<RetryPolicy>;
}): Promise<OtlpSink> {
  const redactor = createRedactor(collectKnownSecrets(process.env));
  const envTimeout =
    getNumberFromEnv('OTEL_EXPORTER_OTLP_LOGS_TIMEOUT') ?? getNumberFromEnv('OTEL_EXPORTER_OTLP_TIMEOUT');
  const exportTimeoutMs = Math.min(
    envTimeout !== undefined && envTimeout > 0 ? envTimeout : 10_000,
    MAX_EXPORT_TIMEOUT_MS,
  );
  const exporter = opts.exporter ?? (await createExporter(opts.protocol, exportTimeoutMs));
  const runId = process.env.FACTORY_RUN_ID?.trim();
  const resource = defaultResource()
    .merge(
      resourceFromAttributes({
        'service.name': 'factory',
        'service.version': opts.version,
        'process.pid': process.pid,
        'factory.session.id': PROCESS_TAG,
        ...(runId ? { 'factory.run.id': runId } : {}),
      }),
    )
    .merge(detectResources({ detectors: [resourceAttributesEnvDetector, serviceNameEnvDetector] }));
  await resource.waitForAsyncAttributes?.();
  const queue = createExportQueue({ exporter, exportTimeoutMs, limits: opts.limits, retry: opts.retry });

  const record = (eventName: string, attributes: Attributes, ts: number, body?: string): ReadableLogRecord => {
    const time = millisToHrTime(ts);
    return {
      hrTime: time,
      hrTimeObserved: time,
      eventName,
      body,
      attributes,
      resource,
      instrumentationScope: SCOPE,
      droppedAttributesCount: 0,
    };
  };
  const counts = { commands: 0, records: 0, withheld: 0, interrupted: 0 };
  const open = new Set<{ interrupt(): void }>();
  const startedAt = Date.now();
  queue.enqueue({
    kind: 'session',
    bytes: RECORD_OVERHEAD_BYTES,
    build: () => record('factory.session.start', { 'factory.version': opts.version }, startedAt),
  });

  function openCommand(id: string, argv: readonly string[], o: { cwd?: string; shell?: boolean }): CommandStreamSink {
    counts.commands++;
    const account: DeliveryAccount = newAccount();
    const base = { 'factory.command.id': id };
    const framers = {
      stdout: createLineFramer(redactor.redact, redactor.holdBack),
      stderr: createLineFramer(redactor.redact, redactor.holdBack),
    };
    const streams = { stdout: { bytes: 0, records: 0 }, stderr: { bytes: 0, records: 0 } };
    let seq = 0;
    let ended = false;
    const commandLine = redactor.redact(argv.join(' '));
    const startedAt = Date.now();
    queue.enqueue({
      kind: 'marker',
      bytes: RECORD_OVERHEAD_BYTES + Buffer.byteLength(commandLine),
      account,
      build: () =>
        record(
          'factory.command.start',
          {
            ...base,
            'factory.command.seq': 0,
            'process.command_line': commandLine,
            'factory.command.shell': o.shell === true,
            'factory.command.cwd': basename(o.cwd ?? process.cwd()),
          },
          startedAt,
        ),
    });

    const emit = (stream: OutputStream, segments: OutputSegment[]) => {
      for (const s of segments) {
        const attrs: Attributes = {
          ...base,
          'factory.command.seq': ++seq,
          'log.iostream': stream,
          'factory.output.offset': s.offset,
          ...(s.partial ? { 'factory.output.partial': true } : {}),
          ...(s.withheld ? { 'factory.output.withheld': true } : {}),
        };
        const ts = Date.now();
        const admitted = queue.enqueue({
          kind: 'output',
          bytes: RECORD_OVERHEAD_BYTES + Buffer.byteLength(s.text),
          account,
          build: () => record('factory.command.output', attrs, ts, s.text),
        });
        if (admitted) {
          streams[stream].records++;
          counts.records++;
        }
      }
    };

    const finish = (result: CommandStreamEnd, interrupted: boolean) => {
      if (ended) return;
      ended = true;
      open.delete(handle);
      emit('stdout', framers.stdout.end());
      emit('stderr', framers.stderr.end());
      const endSeq = ++seq;
      const endedAt = Date.now();
      queue.enqueue({
        kind: 'marker',
        barrier: true,
        bytes: RECORD_OVERHEAD_BYTES * 3,
        account,
        build: () =>
          record(
            'factory.command.end',
            {
              ...base,
              'factory.command.seq': endSeq,
              ...(result.exitCode !== null ? { 'process.exit.code': result.exitCode } : {}),
              ...(result.signal ? { 'process.exit.signal': result.signal } : {}),
              'factory.command.timed_out': result.timedOut,
              'factory.command.max_buffer_exceeded': result.maxBufferExceeded,
              'factory.command.stdout.bytes': streams.stdout.bytes,
              'factory.command.stdout.records': streams.stdout.records,
              'factory.command.stderr.bytes': streams.stderr.bytes,
              'factory.command.stderr.records': streams.stderr.records,
              'factory.command.dropped': account.dropped,
              'factory.command.export_failed': account.failed,
              ...(interrupted ? { 'factory.command.interrupted': true } : {}),
              'factory.command.complete':
                !interrupted && account.dropped === 0 && account.failed === 0 && account.markersDropped === 0,
            },
            endedAt,
          ),
      });
    };

    const handle = {
      interrupt: () => {
        counts.interrupted++;
        finish({ exitCode: null, signal: null, timedOut: false, maxBufferExceeded: false }, true);
      },
    };
    open.add(handle);
    return {
      write(stream, chunk) {
        if (ended) return;
        streams[stream].bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        emit(stream, framers[stream].push(chunk));
      },
      end: (result) => finish(result, false),
    };
  }

  return {
    openCommand,
    countWithheld: () => void counts.withheld++,
    async close(reason, budgetMs) {
      for (const h of open) h.interrupt();
      const endedAt = Date.now();
      const t = queue.totals;
      const clean = () => t.failed === 0 && t.dropped === 0 && t.markersDropped === 0 && counts.interrupted === 0;
      queue.enqueue({
        kind: 'session',
        barrier: true,
        bytes: RECORD_OVERHEAD_BYTES * 3,
        build: () =>
          record(
            'factory.session.end',
            {
              'factory.session.reason': reason,
              'factory.session.commands': counts.commands,
              'factory.session.records': counts.records,
              'factory.session.dropped': t.dropped,
              'factory.session.export_failed': t.failed,
              'factory.session.markers_dropped': t.markersDropped,
              'factory.session.withheld': counts.withheld,
              'factory.session.interrupted': counts.interrupted,
              'factory.session.complete': clean(),
            },
            endedAt,
          ),
      });
      const drained = await queue.flush(budgetMs);
      queue.stop();
      return {
        ...counts,
        acked: t.acked,
        dropped: t.dropped,
        exportFailed: t.failed,
        markersDropped: t.markersDropped,
        unsent: t.queued,
        retries: t.retries,
        complete: drained && clean(),
      };
    },
  };
}
