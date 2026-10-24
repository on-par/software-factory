// src/logger/index.ts — Structured leveled logger over the `.factory/events.ndjson` sink.
// `.factory/events.ndjson` is the canonical structured sink (see ADR-0002); pino was
// deliberately not adopted for this log path — see
// docs/adr/0002-structured-logging-via-event-log.md.
// The live file rotates by size into `state/logs/events/` segments, under the event-log lock (#1631).

import { closeSync, fstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { rotateEventLog } from '../events/tail.js';
import { resolveEventLogRotation, type EventLogRotation } from '../events/rotation.js';
import type { RunAttribution } from '../run/outcome.js';
import type { EscalateKind } from '../types/index.js';
import type {
  EventKind,
  FlakyTestsPayload,
  LanePausedPayload,
  ParkPayload,
  ProviderAuthRejectedPayload,
  ProviderBreakerClosePayload,
  ProviderCappedPayload,
  ProviderRefusedPayload,
  StewardTriggeredPayload,
} from '../events/kinds.js';
import type {
  CheckFailureInfo,
  CiFailureEvidence,
  EvidencePack,
  FactoryEvent,
  FailoverReason,
  LogLevel,
  QueueReprioritizationRecord,
  ReadinessInfo,
  ReworkInfo,
} from '../types/index.js';
import { colorEnabled, formatEventLine } from '../utils/format.js';
import { withFileLockSync } from '../utils/lock.js';
import { resolveRepoSlug } from './repo-slug.js';

export interface LogContext {
  lane?: string;
  issue?: string | number;
  phase?: string;
  /** Overrides git-derived repo resolution for the emitted events' `repo` field (#971). */
  repo?: string;
}

export interface LogExtra {
  paths?: string[];
  mode?: 'mechanical';
  failoverReason?: FailoverReason;
  fingerprint?: string;
  evidence?: EvidencePack;
  rework?: ReworkInfo;
  readiness?: ReadinessInfo;
  queueReprioritization?: QueueReprioritizationRecord;
  lanePaused?: LanePausedPayload;
  park?: ParkPayload;
  providerCapped?: ProviderCappedPayload;
  providerRefused?: ProviderRefusedPayload;
  providerAuthRejected?: ProviderAuthRejectedPayload;
  providerBreakerClose?: ProviderBreakerClosePayload;
  stewardTriggered?: StewardTriggeredPayload;
  flakyTests?: FlakyTestsPayload;
  checkFailure?: CheckFailureInfo;
  ciFailure?: CiFailureEvidence;
  escalateKind?: EscalateKind;
  actor?: string;
  model?: string;
  tokens?: { input: number; output: number };
  durationMs?: number;
  attribution?: RunAttribution;
}

export interface LoggerOptions {
  out?: { write(s: string): unknown; isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
  /** Event-log lock tuning; tests lower these. */
  lock?: { timeoutMs?: number; pollMs?: number };
  /** Size rotation of the events file (#1631); overrides env and repo config. Tests pass a small maxBytes. */
  rotation?: Partial<EventLogRotation>;
}

export interface FactoryLogger {
  debug(type: EventKind, msg: string, extra?: LogExtra): void;
  info(type: EventKind, msg: string, extra?: LogExtra): void;
  warn(type: EventKind, msg: string, extra?: LogExtra): void;
  error(type: EventKind, msg: string, extra?: LogExtra): void;
  child(ctx: LogContext): FactoryLogger;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function resolveThreshold(env: NodeJS.ProcessEnv): LogLevel {
  const raw = env.FACTORY_LOG_LEVEL;
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

function appendLine(
  eventsFile: string,
  line: string,
  rotation: EventLogRotation,
  lock?: { timeoutMs?: number; pollMs?: number },
): void {
  const writeOnce = (): number => {
    const fd = openSync(eventsFile, 'a');
    try {
      writeSync(fd, line);
      return fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
  };
  const doAppend = (): number => {
    try {
      return writeOnce();
    } catch {
      mkdirSync(resolve(eventsFile, '..'), { recursive: true });
      return writeOnce();
    }
  };
  try {
    withFileLockSync(
      `${eventsFile}.lock`,
      () => {
        const size = doAppend();
        if (size <= rotation.maxBytes) return;
        try {
          rotateEventLog(eventsFile, { maxSegments: rotation.maxSegments });
        } catch {
          // the event is written; never fail a log call over rotation
        }
      },
      { timeoutMs: lock?.timeoutMs ?? 10_000, pollMs: lock?.pollMs ?? 5 },
    );
  } catch {
    // Lock stuck past timeout: a possibly-torn line beats a lost event or a
    // crashed lane. Dead holders are already stolen by the lock itself.
    doAppend();
  }
}

export function createLogger(eventsFile: string, ctx: LogContext = {}, opts: LoggerOptions = {}): FactoryLogger {
  const out = opts.out ?? process.stdout;
  const env = opts.env ?? process.env;
  const rotation = resolveEventLogRotation(eventsFile, env, opts.rotation);
  const repo = ctx.repo ?? resolveRepoSlug(dirname(eventsFile));

  function write(level: LogLevel, type: EventKind, msg: string, extra?: LogExtra): void {
    const event: FactoryEvent = {
      ts: new Date().toISOString(),
      type,
      issue: String(ctx.issue ?? '-'),
      msg,
      level,
      ...(extra?.paths ? { paths: extra.paths } : {}),
      ...(extra?.mode ? { mode: extra.mode } : {}),
      ...(ctx.lane ? { lane: ctx.lane } : {}),
      ...(repo ? { repo } : {}),
      ...(ctx.phase ? { phase: ctx.phase } : {}),
      ...(extra?.actor ? { actor: extra.actor } : {}),
      ...(extra?.failoverReason ? { failoverReason: extra.failoverReason } : {}),
      ...(extra?.fingerprint ? { fingerprint: extra.fingerprint } : {}),
      ...(extra?.evidence ? { evidence: extra.evidence } : {}),
      ...(extra?.rework ? { rework: extra.rework } : {}),
      ...(extra?.readiness ? { readiness: extra.readiness } : {}),
      ...(extra?.queueReprioritization !== undefined ? { queueReprioritization: extra.queueReprioritization } : {}),
      ...(extra?.lanePaused ? { lanePaused: extra.lanePaused } : {}),
      ...(extra?.park ? { park: extra.park } : {}),
      ...(extra?.providerCapped ? { providerCapped: extra.providerCapped } : {}),
      ...(extra?.providerRefused ? { providerRefused: extra.providerRefused } : {}),
      ...(extra?.providerAuthRejected ? { providerAuthRejected: extra.providerAuthRejected } : {}),
      ...(extra?.providerBreakerClose ? { providerBreakerClose: extra.providerBreakerClose } : {}),
      ...(extra?.stewardTriggered ? { stewardTriggered: extra.stewardTriggered } : {}),
      ...(extra?.flakyTests ? { flakyTests: extra.flakyTests } : {}),
      ...(extra?.checkFailure ? { checkFailure: extra.checkFailure } : {}),
      ...(extra?.ciFailure ? { ciFailure: extra.ciFailure } : {}),
      ...(extra?.escalateKind ? { escalateKind: extra.escalateKind } : {}),
      ...(extra?.attribution ? { attribution: extra.attribution } : {}),
      ...(extra?.model ? { model: extra.model } : {}),
      ...(extra?.tokens ? { tokens: extra.tokens } : {}),
      ...(extra?.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
    };
    const line = JSON.stringify(event) + '\n';
    appendLine(eventsFile, line, rotation, opts.lock);

    if (LEVEL_RANK[level] < LEVEL_RANK[resolveThreshold(env)]) return;

    if (env.FACTORY_LOG_FORMAT === 'json') {
      out.write(line);
    } else {
      out.write(
        formatEventLine(type, event.issue, msg, { color: colorEnabled(out, env), lane: ctx.lane, ts: event.ts }) + '\n',
      );
    }
  }

  return {
    debug: (type, msg, extra) => write('debug', type, msg, extra),
    info: (type, msg, extra) => write('info', type, msg, extra),
    warn: (type, msg, extra) => write('warn', type, msg, extra),
    error: (type, msg, extra) => write('error', type, msg, extra),
    child: (childCtx) => createLogger(eventsFile, { ...ctx, ...childCtx }, opts),
  };
}
