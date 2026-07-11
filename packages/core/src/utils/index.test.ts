import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  slugify,
  shellEscape,
  branchFor,
  cleanupWorktree,
  logEvent,
  logCost,
  readCosts,
  ensureDir,
  readJsonIfExists,
} from './index.js';

let tmpDir: string | undefined;

describe('utils', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('slugifies text for branch-safe identifiers', () => {
    expect(slugify('Hello, World! 123')).toBe('hello-world-123');
    expect(slugify('  --Trim--  ')).toBe('trim');
    expect(slugify('a very long title that should be truncated by slugify').length).toBeLessThanOrEqual(32);
  });

  it('escapes strings for single-quoted shell arguments', () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
    expect(shellEscape('plain')).toBe("'plain'");
  });

  it('builds a ship-it branch from issue and title, matching slugify', () => {
    expect(branchFor(22, 'Reliably detect a merged PR')).toBe(`ship-it/22-${slugify('Reliably detect a merged PR')}`);
    expect(branchFor(7, 'Hello, World!')).toBe('ship-it/7-hello-world');
  });

  it('logs worktree cleanup failures without rejecting', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-cleanup-'));
    const worktreePath = join(tmpDir, 'nonexistent-wt');
    const spy = vi.fn();

    await expect(cleanupWorktree(tmpDir, worktreePath, spy)).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('nonexistent-wt'),
    );
  });

  it('appends events as NDJSON', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-events-'));
    const eventsFile = join(tmpDir, 'events.ndjson');

    logEvent(eventsFile, 'plan', 85, 'first');
    logEvent(eventsFile, 'build', '85', 'second');

    const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    const events = lines.map(line => JSON.parse(line));
    expect(events[0]).toEqual({
      ts: expect.any(String),
      type: 'plan',
      issue: '85',
      msg: 'first',
    });
    expect(events[1]).toEqual({
      ts: expect.any(String),
      type: 'build',
      issue: '85',
      msg: 'second',
    });
  });

  it('creates missing directories when logging events', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-events-'));
    const eventsFile = join(tmpDir, 'nested', 'sub', 'events.ndjson');

    logEvent(eventsFile, 'plan', 85, 'created');

    expect(existsSync(eventsFile)).toBe(true);
    const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      ts: expect.any(String),
      type: 'plan',
      issue: '85',
      msg: 'created',
    });
  });

  it('round-trips costs with timestamps', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-costs-'));
    const costsFile = join(tmpDir, 'costs.ndjson');
    const first = {
      issue: '85',
      task: 'plan',
      model: 'claude-opus-4-8',
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.01,
    };
    const second = {
      issue: '86',
      task: 'build',
      model: 'claude-sonnet-4-8',
      inputTokens: 25,
      outputTokens: 75,
      cost: 0.02,
    };

    logCost(costsFile, first);
    logCost(costsFile, second);

    const costs = readCosts(costsFile);
    expect(costs).toHaveLength(2);
    expect(costs[0]).toEqual({ ...first, ts: expect.any(String) });
    expect(costs[1]).toEqual({ ...second, ts: expect.any(String) });
    expect(costs.reduce((sum, entry) => sum + entry.cost, 0)).toBe(0.03);
    expect(costs.reduce((sum, entry) => sum + entry.inputTokens, 0)).toBe(125);
  });

  it('skips malformed cost lines without throwing', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-costs-'));
    const costsFile = join(tmpDir, 'costs.ndjson');
    const first = {
      ts: '2026-07-11T00:00:00.000Z',
      issue: '85',
      task: 'plan',
      model: 'claude-opus-4-8',
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.01,
    };
    const second = {
      ts: '2026-07-11T00:01:00.000Z',
      issue: '85',
      task: 'build',
      model: 'claude-sonnet-4-8',
      inputTokens: 25,
      outputTokens: 75,
      cost: 0.02,
    };
    writeFileSync(costsFile, `${JSON.stringify(first)}\nnot json{\n${JSON.stringify(second)}\n`);

    expect(() => readCosts(costsFile)).not.toThrow();
    expect(readCosts(costsFile)).toEqual([first, second]);
  });

  it('returns no costs for a missing file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-costs-'));

    expect(readCosts(join(tmpDir, 'does-not-exist.ndjson'))).toEqual([]);
  });

  it('ensures directories exist idempotently', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-dirs-'));
    const path = join(tmpDir, 'newdir');

    ensureDir(path);
    expect(existsSync(path)).toBe(true);
    expect(() => ensureDir(path)).not.toThrow();
  });

  it('reads JSON files with a fallback for missing or invalid files', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-json-'));
    const jsonFile = join(tmpDir, 'data.json');
    const invalidFile = join(tmpDir, 'invalid.json');
    const fallback = { ok: false };

    writeFileSync(jsonFile, JSON.stringify({ ok: true, count: 2 }));
    expect(readJsonIfExists(jsonFile, fallback)).toEqual({ ok: true, count: 2 });
    expect(readJsonIfExists(join(tmpDir, 'missing.json'), fallback)).toBe(fallback);

    writeFileSync(invalidFile, 'not json{');
    expect(readJsonIfExists(invalidFile, fallback)).toBe(fallback);
  });
});
