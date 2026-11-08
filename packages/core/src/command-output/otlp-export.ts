// packages/core/src/command-output/otlp-export.ts — opt-in OTLP/HTTP export of redacted CHECK command output through
// the official OpenTelemetry JS SDK, with bounded buffering and explicit loss accounting (#3995)
import type { LogRecordExporter, LogRecordProcessor, ReadableLogRecord } from '@opentelemetry/sdk-logs';

import {
  type CommandOutputCorrelation,
  type CommandOutputRecord,
  registerCommandOutputSink,
  withCommandOutputScope,
} from './capture.js';
import { createExportQueue, type ExportQueue, type SendOutcome } from './export-queue.js';
import type { CommandOutputEventKind } from '../events/command-output-traits.js';

type Env = Record<string, string | undefined>;
type Protocol = 'http/protobuf' | 'http/json';

export type CommandOutputExportResolution =
  { enabled: true; protocol: Protocol } | { enabled: false; warning?: string };

export interface CommandOutputExportDeps {
  env?: Env;
  createExporter?: (protocol: Protocol) => Promise<LogRecordExporter>;
  flushBudgetMs?: number;
  maxQueued?: number;
  retry?: { initialMs?: number; maxMs?: number; maxAttempts?: number };
}

const SEVERITY_INFO = 9;
const SEVERITY_WARN = 13;
const DEFAULT_FLUSH_BUDGET_MS = 5000;
const EXPORTER_TIMEOUT_CAP_MS = 2000;
const EXPORTER_SHUTDOWN_MS = 500;

const norm = (v: string | undefined): string => (v ?? '').trim().toLowerCase();
const disabled = (warning?: string): CommandOutputExportResolution =>
  warning === undefined ? { enabled: false } : { enabled: false, warning };

export function resolveCommandOutputExport(env: Env): CommandOutputExportResolution {
  if (norm(env.FACTORY_COMMAND_OUTPUT_EXPORT) !== 'otlp') return disabled();
  if (norm(env.OTEL_SDK_DISABLED) === 'true') return disabled();
  const listed = norm(env.OTEL_LOGS_EXPORTER)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const exporters = listed.length === 0 ? ['otlp'] : listed;
  if (exporters.includes('none')) return disabled();
  if (!exporters.includes('otlp')) {
    return disabled('command output export disabled: OTEL_LOGS_EXPORTER does not include otlp');
  }
  const hasEndpoint = [env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, env.OTEL_EXPORTER_OTLP_ENDPOINT].some(
    (v) => (v ?? '').trim() !== '',
  );
  if (!hasEndpoint) {
    return disabled(
      'command output export disabled: set OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    );
  }
  const protocol =
    [env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, env.OTEL_EXPORTER_OTLP_PROTOCOL]
      .map((v) => (v ?? '').trim())
      .find((v) => v !== '') ?? 'http/protobuf';
  if (protocol !== 'http/protobuf' && protocol !== 'http/json') {
    return disabled(
      `command output export disabled: unsupported OTLP protocol '${protocol}' (use http/protobuf or http/json)`,
    );
  }
  return { enabled: true, protocol };
}

function headerSecrets(env: Env): string[] {
  const secrets: string[] = [];
  for (const raw of [env.OTEL_EXPORTER_OTLP_HEADERS, env.OTEL_EXPORTER_OTLP_LOGS_HEADERS]) {
    for (const pair of (raw ?? '').split(',')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      let value = pair.slice(eq + 1);
      try {
        value = decodeURIComponent(value);
      } catch {
        // keep the raw value when it is not valid percent-encoding
      }
      value = value.trim();
      if (value.length >= 4) secrets.push(value);
    }
  }
  return secrets;
}

function unrefTimer(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

async function importExporter(protocol: Protocol, timeoutMillis: number): Promise<LogRecordExporter> {
  const mod =
    protocol === 'http/protobuf'
      ? await import('@opentelemetry/exporter-logs-otlp-proto')
      : await import('@opentelemetry/exporter-logs-otlp-http');
  return new mod.OTLPLogExporter({ timeoutMillis });
}

interface ExportSetup {
  exporter: LogRecordExporter;
  queue: ExportQueue<ReadableLogRecord>;
  unregister: () => void;
}

async function setupExport(
  correlation: CommandOutputCorrelation,
  protocol: Protocol,
  env: Env,
  deps: CommandOutputExportDeps,
): Promise<ExportSetup> {
  const envTimeout = Number(env.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT ?? env.OTEL_EXPORTER_OTLP_TIMEOUT);
  const timeoutMillis = Math.min(
    Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 10000,
    EXPORTER_TIMEOUT_CAP_MS,
  );
  const exporter = deps.createExporter
    ? await deps.createExporter(protocol)
    : await importExporter(protocol, timeoutMillis);
  const { ExportResultCode } = await import('@opentelemetry/core');
  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  const { LoggerProvider } = await import('@opentelemetry/sdk-logs');

  const queue = createExportQueue<ReadableLogRecord>({
    maxQueued: deps.maxQueued,
    retry: deps.retry,
    send: (batch) =>
      new Promise<SendOutcome>((resolve) => {
        try {
          exporter.export(batch, (result) => resolve(result.code === ExportResultCode.SUCCESS ? 'ok' : 'failed'));
        } catch {
          resolve('failed');
        }
      }),
  });

  class QueueLogRecordProcessor implements LogRecordProcessor {
    onEmit(record: ReadableLogRecord): void {
      queue.enqueue(record);
    }
    forceFlush(): Promise<void> {
      return Promise.resolve();
    }
    shutdown(): Promise<void> {
      return Promise.resolve();
    }
  }

  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ 'service.name': env.OTEL_SERVICE_NAME?.trim() || 'software-factory' }),
    processors: [new QueueLogRecordProcessor()],
  });
  const logger = provider.getLogger('factory.command_output', '1');
  const secrets = headerSecrets(env);
  const mask = (text: string): string => secrets.reduce((t, s) => t.split(s).join('<secret>'), text);

  const unregister = registerCommandOutputSink((record: CommandOutputRecord) => {
    if (record.runId !== correlation.runId) return;
    try {
      logger.emit({
        body: mask(record.text),
        timestamp: new Date(record.time),
        severityNumber: record.stream === 'stderr' ? SEVERITY_WARN : SEVERITY_INFO,
        attributes: {
          'factory.run_id': record.runId,
          'factory.issue': record.issue,
          'factory.lane': record.lane,
          'factory.phase': record.phase,
          'factory.command_id': record.commandId,
          'factory.seq': record.seq,
          'log.iostream': record.stream,
        },
      });
    } catch {
      // export problems never reach the command
    }
  });
  return { exporter, queue, unregister };
}

export async function withCommandOutputExport<T>(
  correlation: CommandOutputCorrelation,
  log: (type: CommandOutputEventKind, msg: string) => void,
  fn: () => Promise<T>,
  deps: CommandOutputExportDeps = {},
): Promise<T> {
  const env = deps.env ?? process.env;
  const res = resolveCommandOutputExport(env);
  if (!res.enabled) {
    if (res.warning !== undefined) log('command_output_export_degraded', res.warning);
    return withCommandOutputScope(correlation, fn);
  }
  let setup: ExportSetup;
  try {
    setup = await setupExport(correlation, res.protocol, env, deps);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log('command_output_export_degraded', `command output export disabled: setup failed: ${reason}`);
    return withCommandOutputScope(correlation, fn);
  }
  try {
    return await withCommandOutputScope(correlation, fn);
  } finally {
    try {
      setup.unregister();
      const c = await setup.queue.close(deps.flushBudgetMs ?? DEFAULT_FLUSH_BUDGET_MS);
      await Promise.race([setup.exporter.shutdown().catch(() => {}), unrefTimer(EXPORTER_SHUTDOWN_MS)]);
      const msg = `command output export: ${c.sent} sent, ${c.dropped} dropped, ${c.failed} failed (${c.retries} retries)`;
      log(c.dropped + c.failed > 0 ? 'command_output_export_degraded' : 'command_output_export', msg);
    } catch {
      // the export summary must never throw over fn's result or error
    }
  }
}
