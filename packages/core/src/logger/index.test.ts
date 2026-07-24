import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { EvidencePack } from '../types/index.js';
import { createLogger } from './index.js';

let tmpDir: string | undefined;

function readEvents(eventsFile: string): any[] {
  return readFileSync(eventsFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('createLogger', () => {
  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('appends a parseable NDJSON line for every level, with ts/type/issue/msg/level', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const out: string[] = [];
    const logger = createLogger(eventsFile, {}, { out: { write: (s) => out.push(s) } });

    logger.debug('debug-type', 'a debug message');
    logger.info('info-type', 'an info message');
    logger.warn('warn-type', 'a warn message');
    logger.error('error-type', 'an error message');

    const events = readEvents(eventsFile);
    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({
      ts: expect.any(String),
      type: 'debug-type',
      issue: '-',
      msg: 'a debug message',
      level: 'debug',
    });
    expect(events[1]).toEqual({
      ts: expect.any(String),
      type: 'info-type',
      issue: '-',
      msg: 'an info message',
      level: 'info',
    });
    expect(events[2]).toEqual({
      ts: expect.any(String),
      type: 'warn-type',
      issue: '-',
      msg: 'a warn message',
      level: 'warn',
    });
    expect(events[3]).toEqual({
      ts: expect.any(String),
      type: 'error-type',
      issue: '-',
      msg: 'an error message',
      level: 'error',
    });
  });

  it('includes lane/phase in the event when bound in context, omits them when absent', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const logger = createLogger(eventsFile, { lane: 'app', issue: 42, phase: 'build' }, { out: { write: () => {} } });

    logger.info('build', 'building');

    const [event] = readEvents(eventsFile);
    expect(event).toEqual({
      ts: expect.any(String),
      type: 'build',
      issue: '42',
      msg: 'building',
      level: 'info',
      lane: 'app',
      phase: 'build',
    });
  });

  it('omits absent context keys entirely from the JSON', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const logger = createLogger(eventsFile, {}, { out: { write: () => {} } });

    logger.info('plan', 'no context bound');

    const [event] = readEvents(eventsFile);
    expect(Object.keys(event).sort()).toEqual(['issue', 'level', 'msg', 'ts', 'type']);
  });

  it('includes failoverReason only when passed as extra', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const logger = createLogger(eventsFile, { issue: 5 }, { out: { write: () => {} } });

    logger.warn('router', 'failing over', { failoverReason: 'rate_limit' });

    const [event] = readEvents(eventsFile);
    expect(event.failoverReason).toBe('rate_limit');
  });

  it('includes actor only when passed as extra', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const logger = createLogger(eventsFile, {}, { out: { write: () => {} } });

    logger.info('human-restarted', 'msg', { actor: 'alice' });

    const [event] = readEvents(eventsFile);
    expect(event.actor).toBe('alice');
  });

  it('includes fingerprint and evidence only when passed as extra', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const logger = createLogger(eventsFile, { issue: 5 }, { out: { write: () => {} } });
    const evidence: EvidencePack = {
      repo: 'on-par/software-factory',
      issue: '372',
      phase: 'check',
      model: 'claude-sonnet-5',
      reason: 'verify_failed',
      component: 'check:tests',
      origin: 'product',
      eventExcerpt: 'test suite failed',
      logPath: eventsFile,
    };

    logger.error('parked', 'msg', { fingerprint: 'ff_abc', evidence });

    const [event] = readEvents(eventsFile);
    expect(event.fingerprint).toBe('ff_abc');
    expect(event.evidence).toEqual(evidence);
  });

  it('omits fingerprint and evidence when not supplied', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const logger = createLogger(eventsFile, {}, { out: { write: () => {} } });

    logger.info('plan', 'no fingerprint');

    const [event] = readEvents(eventsFile);
    expect(event).not.toHaveProperty('fingerprint');
    expect(event).not.toHaveProperty('evidence');
  });

  it('includes model and tokens only when passed as extra', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const logger = createLogger(eventsFile, { issue: 5 }, { out: { write: () => {} } });

    logger.info('plan', 'complete', { model: 'm', tokens: { input: 1, output: 2 } });

    const [event] = readEvents(eventsFile);
    expect(event.model).toBe('m');
    expect(event.tokens).toEqual({ input: 1, output: 2 });
  });

  it('omits model and tokens when not supplied', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const logger = createLogger(eventsFile, {}, { out: { write: () => {} } });

    logger.info('plan', 'no model');

    const [event] = readEvents(eventsFile);
    expect(event).not.toHaveProperty('model');
    expect(event).not.toHaveProperty('tokens');
  });

  it('includes readiness only when passed as extra', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const logger = createLogger(eventsFile, { issue: 5 }, { out: { write: () => {} } });
    const readiness = { template: 'factory-task' as const, score: 1, pass: true, missing: [] };

    logger.info('readiness', 'issue readiness 100% (factory-task)', { readiness });

    const [event] = readEvents(eventsFile);
    expect(event.readiness).toEqual(readiness);
  });

  it('omits readiness when not supplied', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const logger = createLogger(eventsFile, {}, { out: { write: () => {} } });

    logger.info('plan', 'no readiness');

    const [event] = readEvents(eventsFile);
    expect(event).not.toHaveProperty('readiness');
  });

  it('child(ctx) merges onto the parent context without mutating the parent', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const parent = createLogger(eventsFile, { lane: 'app', issue: 7 }, { out: { write: () => {} } });
    const child = parent.child({ phase: 'build' });

    child.info('build', 'child event');
    parent.info('plan', 'parent event');

    const events = readEvents(eventsFile);
    expect(events[0]).toMatchObject({ lane: 'app', issue: '7', phase: 'build', type: 'build' });
    expect(events[1]).toMatchObject({ lane: 'app', issue: '7', type: 'plan' });
    expect(events[1]).not.toHaveProperty('phase');
  });

  it('child(ctx) later keys win over the parent context', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const parent = createLogger(eventsFile, { lane: 'app', issue: 7 }, { out: { write: () => {} } });
    const child = parent.child({ lane: 'other' });

    child.info('plan', 'overridden lane');

    const [event] = readEvents(eventsFile);
    expect(event.lane).toBe('other');
  });

  describe('console filtering by FACTORY_LOG_LEVEL', () => {
    it('with default env, debug writes to the file but not to out', async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
      const eventsFile = join(tmpDir, 'events.ndjson');
      const out: string[] = [];
      const logger = createLogger(eventsFile, {}, { out: { write: (s) => out.push(s) }, env: {} });

      logger.debug('debug-type', 'hidden from console');

      expect(out).toHaveLength(0);
      expect(readEvents(eventsFile)).toHaveLength(1);
    });

    it('with FACTORY_LOG_LEVEL=debug, debug writes to out', async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
      const eventsFile = join(tmpDir, 'events.ndjson');
      const out: string[] = [];
      const logger = createLogger(
        eventsFile,
        {},
        { out: { write: (s) => out.push(s) }, env: { FACTORY_LOG_LEVEL: 'debug' } },
      );

      logger.debug('debug-type', 'now visible');

      expect(out).toHaveLength(1);
    });

    it('with FACTORY_LOG_LEVEL=error, info is silent on out but present in the file', async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
      const eventsFile = join(tmpDir, 'events.ndjson');
      const out: string[] = [];
      const logger = createLogger(
        eventsFile,
        {},
        { out: { write: (s) => out.push(s) }, env: { FACTORY_LOG_LEVEL: 'error' } },
      );

      logger.info('info-type', 'quiet on console');

      expect(out).toHaveLength(0);
      expect(readEvents(eventsFile)).toHaveLength(1);
    });

    it('an invalid FACTORY_LOG_LEVEL behaves as info', async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
      const eventsFile = join(tmpDir, 'events.ndjson');
      const out: string[] = [];
      const logger = createLogger(
        eventsFile,
        {},
        { out: { write: (s) => out.push(s) }, env: { FACTORY_LOG_LEVEL: 'not-a-level' } },
      );

      logger.debug('debug-type', 'hidden');
      logger.info('info-type', 'visible');

      expect(out).toHaveLength(1);
    });
  });

  describe('console format', () => {
    it('with FACTORY_LOG_FORMAT=json, out receives the JSON line', async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
      const eventsFile = join(tmpDir, 'events.ndjson');
      const out: string[] = [];
      const logger = createLogger(
        eventsFile,
        { lane: 'app', issue: 9, phase: 'build' },
        { out: { write: (s) => out.push(s) }, env: { FACTORY_LOG_FORMAT: 'json' } },
      );

      logger.info('build', 'json line');

      expect(out).toHaveLength(1);
      const parsed = JSON.parse(out[0]);
      expect(parsed).toMatchObject({ level: 'info', lane: 'app', phase: 'build', type: 'build', msg: 'json line' });
    });

    it('with default env, out receives the pretty [factory] line', async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
      const eventsFile = join(tmpDir, 'events.ndjson');
      const out: string[] = [];
      const logger = createLogger(eventsFile, { issue: 9 }, { out: { write: (s) => out.push(s) }, env: {} });

      logger.info('plan', 'pretty line');

      expect(out).toHaveLength(1);
      expect(out[0]).toBe('[factory] plan #9: pretty line\n');
    });
  });

  it('creates the missing parent directory for eventsFile on first write', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'nested', 'sub', 'events.ndjson');
    const logger = createLogger(eventsFile, {}, { out: { write: () => {} } });

    logger.info('plan', 'created dirs');

    expect(existsSync(eventsFile)).toBe(true);
    expect(readEvents(eventsFile)).toHaveLength(1);
  });

  it('append removes the lock dir when done', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const logger = createLogger(eventsFile, {}, { out: { write: () => {} } });

    logger.info('plan', 'locked append');

    expect(existsSync(`${eventsFile}.lock`)).toBe(false);
  });

  it('falls back to an unlocked append when the lock is held past timeout', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const lockDir = `${eventsFile}.lock`;
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'pid'), String(process.pid));

    const logger = createLogger(eventsFile, {}, { out: { write: () => {} }, lock: { timeoutMs: 30, pollMs: 5 } });

    logger.info('plan', 'fallback append');

    expect(readEvents(eventsFile)).toHaveLength(1);
    expect(existsSync(lockDir)).toBe(true);
  });
});
