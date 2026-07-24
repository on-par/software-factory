// src/logger/index.ts — Structured leveled logger over the `.factory/events.ndjson` sink.
// `.factory/events.ndjson` is the canonical structured sink (see ADR-0002); pino was
// deliberately not adopted for this log path — see
// docs/adr/0002-structured-logging-via-event-log.md.

import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { EvidencePack, FactoryEvent, FailoverReason, LogLevel, ReworkInfo } from '../types/index.js';
import { colorEnabled, formatEventLine } from '../utils/format.js';
import { withFileLockSync } from '../utils/lock.js';

export interface LogContext {
  lane?: string;
  issue?: string | number;
  phase?: string;
}

export interface LogExtra {
  failoverReason?: FailoverReason;
  fingerprint?: string;
  evidence?: EvidencePack;
  rework?: ReworkInfo;
  actor?: string;
  model?: string;
  tokens?: { input: number; output: number };
}

export interface LoggerOptions {
  out?: { write(s: string): unknown; isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
  /** Event-log lock tuning; tests lower these. */
  lock?: { timeoutMs?: number; pollMs?: number };
}

export interface FactoryLogger {
  debug(type: string, msg: string, extra?: LogExtra): void;
  info(type: string, msg: string, extra?: LogExtra): void;
  warn(type: string, msg: string, extra?: LogExtra): void;
  error(type: string, msg: string, extra?: LogExtra): void;
  child(ctx: LogContext): FactoryLogger;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function resolveThreshold(env: NodeJS.ProcessEnv): LogLevel {
  const raw = env.FACTORY_LOG_LEVEL;
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

function appendLine(eventsFile: string, line: string, lock?: { timeoutMs?: number; pollMs?: number }): void {
  const doAppend = () => {
    try {
      appendFileSync(eventsFile, line);
    } catch {
      mkdirSync(resolve(eventsFile, '..'), { recursive: true });
      appendFileSync(eventsFile, line);
    }
  };
  try {
    withFileLockSync(`${eventsFile}.lock`, doAppend, {
      timeoutMs: lock?.timeoutMs ?? 10_000,
      pollMs: lock?.pollMs ?? 5,
    });
  } catch {
    // Lock stuck past timeout: a possibly-torn line beats a lost event or a
    // crashed lane. Dead holders are already stolen by the lock itself.
    doAppend();
  }
}

export function createLogger(eventsFile: string, ctx: LogContext = {}, opts: LoggerOptions = {}): FactoryLogger {
  const out = opts.out ?? process.stdout;
  const env = opts.env ?? process.env;

  function write(level: LogLevel, type: string, msg: string, extra?: LogExtra): void {
    const event: FactoryEvent = {
      ts: new Date().toISOString(),
      type,
      issue: String(ctx.issue ?? '-'),
      msg,
      level,
      ...(ctx.lane ? { lane: ctx.lane } : {}),
      ...(ctx.phase ? { phase: ctx.phase } : {}),
      ...(extra?.actor ? { actor: extra.actor } : {}),
      ...(extra?.failoverReason ? { failoverReason: extra.failoverReason } : {}),
      ...(extra?.fingerprint ? { fingerprint: extra.fingerprint } : {}),
      ...(extra?.evidence ? { evidence: extra.evidence } : {}),
      ...(extra?.rework ? { rework: extra.rework } : {}),
      ...(extra?.model ? { model: extra.model } : {}),
      ...(extra?.tokens ? { tokens: extra.tokens } : {}),
    };
    const line = JSON.stringify(event) + '\n';
    appendLine(eventsFile, line, opts.lock);

    if (LEVEL_RANK[level] < LEVEL_RANK[resolveThreshold(env)]) return;

    if (env.FACTORY_LOG_FORMAT === 'json') {
      out.write(line);
    } else {
      out.write(formatEventLine(type, event.issue, msg, { color: colorEnabled(out, env), lane: ctx.lane }) + '\n');
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
