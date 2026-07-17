import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  slugify,
  branchPrefixSlug,
  shellEscape,
  branchFor,
  cleanupWorktree,
  logEvent,
  logCost,
  readCosts,
  ensureDir,
  readJsonIfExists,
  isEscalation,
  escalationLine,
  codexDisabled,
} from './index.js';

let tmpDir: string | undefined;

describe('utils', () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

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

  it('wraps strings with spaces in single quotes', () => {
    expect(shellEscape('path with spaces/file.txt')).toBe("'path with spaces/file.txt'");
  });

  it('preserves double quotes and shell metacharacters inside single quotes', () => {
    expect(shellEscape('say "hi" && rm -rf /')).toBe('\'say "hi" && rm -rf /\'');
  });

  it('escapes multiple embedded single quotes', () => {
    expect(shellEscape("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it('handles the empty string', () => {
    expect(shellEscape('')).toBe("''");
  });

  it('builds a ship-it branch from issue and title by default, matching slugify', () => {
    expect(branchFor(22, 'Reliably detect a merged PR')).toBe(`ship-it/22-${slugify('Reliably detect a merged PR')}`);
    expect(branchFor(7, 'Hello, World!')).toBe('ship-it/7-hello-world');
  });

  it('allows comparison runs to use a custom branch prefix', () => {
    const prev = process.env.FACTORY_BRANCH_PREFIX;
    process.env.FACTORY_BRANCH_PREFIX = 'compare-local';
    try {
      expect(branchFor(7, 'Hello, World!')).toBe('compare-local/7-hello-world');
    } finally {
      if (prev === undefined) delete process.env.FACTORY_BRANCH_PREFIX;
      else process.env.FACTORY_BRANCH_PREFIX = prev;
    }
  });

  it('falls back to ship-it when the custom branch prefix has no slug characters', () => {
    const prev = process.env.FACTORY_BRANCH_PREFIX;
    process.env.FACTORY_BRANCH_PREFIX = '!!!';
    try {
      expect(branchPrefixSlug()).toBe('ship-it');
      expect(branchFor(7, 'Hello, World!')).toBe('ship-it/7-hello-world');
    } finally {
      if (prev === undefined) delete process.env.FACTORY_BRANCH_PREFIX;
      else process.env.FACTORY_BRANCH_PREFIX = prev;
    }
  });

  it('logs worktree cleanup failures without rejecting', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-cleanup-'));
    const worktreePath = join(tmpDir, 'nonexistent-wt');
    const spy = vi.fn();

    await expect(cleanupWorktree(tmpDir, worktreePath, spy)).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledWith('warn', expect.stringContaining('nonexistent-wt'));
  });

  it('appends events as NDJSON with a level derived from type', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-events-'));
    const eventsFile = join(tmpDir, 'events.ndjson');

    logEvent(eventsFile, 'plan', 85, 'first');
    logEvent(eventsFile, 'build', '85', 'second');

    const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    const events = lines.map((line) => JSON.parse(line));
    expect(events[0]).toEqual({
      ts: expect.any(String),
      type: 'plan',
      issue: '85',
      msg: 'first',
      level: 'info',
    });
    expect(events[1]).toEqual({
      ts: expect.any(String),
      type: 'build',
      issue: '85',
      msg: 'second',
      level: 'info',
    });
  });

  it('derives level=error for error-category types like fail', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-events-'));
    const eventsFile = join(tmpDir, 'events.ndjson');

    logEvent(eventsFile, 'fail', 85, 'boom');

    const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean);
    expect(JSON.parse(lines[0]).level).toBe('error');
  });

  it('logs a structured failoverReason when extra is provided', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-events-'));
    const eventsFile = join(tmpDir, 'events.ndjson');

    logEvent(eventsFile, 'failover', 5, 'msg', { failoverReason: 'rate_limit' });

    const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean);
    expect(JSON.parse(lines[0])).toEqual({
      ts: expect.any(String),
      type: 'failover',
      issue: '5',
      msg: 'msg',
      level: 'info',
      failoverReason: 'rate_limit',
    });
  });

  it('includes lane and phase in the written event when passed as extra', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-events-'));
    const eventsFile = join(tmpDir, 'events.ndjson');

    logEvent(eventsFile, 'build', 5, 'msg', { lane: 'app', phase: 'build' });

    const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean);
    expect(JSON.parse(lines[0])).toEqual({
      ts: expect.any(String),
      type: 'build',
      issue: '5',
      msg: 'msg',
      level: 'info',
      lane: 'app',
      phase: 'build',
    });
  });

  it('omits failoverReason/lane/phase when extra is not provided (old shape preserved plus level)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-events-'));
    const eventsFile = join(tmpDir, 'events.ndjson');

    logEvent(eventsFile, 'plan', 5, 'msg');

    const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).not.toHaveProperty('failoverReason');
    expect(Object.keys(parsed).sort()).toEqual(['issue', 'level', 'msg', 'ts', 'type']);
  });

  it('creates missing directories when logging events', async () => {
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
      level: 'info',
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

  it('round-trips a failoverReason on a cost entry', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-costs-'));
    const costsFile = join(tmpDir, 'costs.ndjson');
    const entry = {
      issue: '85',
      task: 'build_codex',
      model: 'qwen-local',
      inputTokens: 10,
      outputTokens: 5,
      cost: 0,
      failoverReason: 'usage_cap' as const,
    };

    logCost(costsFile, entry);

    const costs = readCosts(costsFile);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toEqual({ ...entry, ts: expect.any(String) });
  });

  it('reads both a pre-change line (no failoverReason) and a new line from the same file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-costs-'));
    const costsFile = join(tmpDir, 'costs.ndjson');
    const oldLine = {
      ts: '2026-07-11T00:00:00.000Z',
      issue: '85',
      task: 'plan',
      model: 'claude-opus-4-8',
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.01,
    };
    const newLine = {
      ts: '2026-07-16T00:00:00.000Z',
      issue: '86',
      task: 'build_codex',
      model: 'qwen-local',
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      failoverReason: 'rate_limit',
    };
    writeFileSync(costsFile, `${JSON.stringify(oldLine)}\n${JSON.stringify(newLine)}\n`);

    expect(() => readCosts(costsFile)).not.toThrow();
    expect(readCosts(costsFile)).toEqual([oldLine, newLine]);
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

describe('isEscalation / escalationLine', () => {
  it('matches a line-start escalation marker', () => {
    const output = 'ESCALATE: missing product decision';

    expect(isEscalation(output)).toBe(true);
    expect(escalationLine(output)).toBe('ESCALATE: missing product decision');
  });

  it('matches a later line-start escalation marker', () => {
    const output = `I inspected the repository.
This issue needs a product decision.
ESCALATE: which behavior should win?`;

    expect(isEscalation(output)).toBe(true);
    expect(escalationLine(output)).toBe('ESCALATE: which behavior should win?');
  });

  it('ignores a mid-paragraph mention of the marker', () => {
    const output = 'Consider whether to ESCALATE: this later.';

    expect(isEscalation(output)).toBe(false);
    expect(escalationLine(output)).toBeUndefined();
  });

  it('does not match empty output or output without a marker', () => {
    expect(isEscalation('')).toBe(false);
    expect(escalationLine('')).toBeUndefined();
    expect(isEscalation('No escalation here.')).toBe(false);
    expect(escalationLine('No escalation here.')).toBeUndefined();
  });
});

describe('codexDisabled', () => {
  const prevFactoryCodex = process.env.FACTORY_CODEX;

  afterEach(() => {
    if (prevFactoryCodex === undefined) delete process.env.FACTORY_CODEX;
    else process.env.FACTORY_CODEX = prevFactoryCodex;
  });

  it('is true when FACTORY_CODEX is exactly "0"', () => {
    process.env.FACTORY_CODEX = '0';
    expect(codexDisabled()).toBe(true);
  });

  it('is false when FACTORY_CODEX is unset', () => {
    delete process.env.FACTORY_CODEX;
    expect(codexDisabled()).toBe(false);
  });

  it('is false when FACTORY_CODEX is "1" or any other value', () => {
    process.env.FACTORY_CODEX = '1';
    expect(codexDisabled()).toBe(false);
    process.env.FACTORY_CODEX = 'false';
    expect(codexDisabled()).toBe(false);
  });
});
