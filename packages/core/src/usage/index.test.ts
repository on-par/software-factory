import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { defaultTranscriptRoots } from './index.js';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  aggregateCosts,
  estimateTrailingSpend,
  formatUsageReport,
  priceFor,
  readCostsFile,
  watchUsage,
} from './index.js';
import type { CostEntry } from '../types/index.js';

const now = new Date('2026-07-10T12:00:00Z');
const tempDirs: string[] = [];

function makeRoot(): string {
  const root = join(mkdtemp(), 'projects');
  mkdirSync(root, { recursive: true });
  return root;
}

function mkdtemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-usage-'));
  tempDirs.push(dir);
  return dir;
}

function writeTranscript(root: string, relativePath: string, lines: string[]): string {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n');
  utimesSync(file, now, now);
  return file;
}

function transcriptLine(timestamp: string, model: string, usage: Record<string, number>): string {
  return JSON.stringify({ timestamp, message: { model, usage } });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('usage', () => {
  it('matches legacy cost math for opus transcript usage', () => {
    const root = makeRoot();
    writeTranscript(root, 'project/session.jsonl', [
      transcriptLine('2026-07-10T11:30:00Z', 'claude-opus-4-8', {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 10000,
        cache_creation_input_tokens: 2000,
      }),
    ]);

    expect(estimateTrailingSpend({ roots: [root], now })).toBeCloseTo(0.105, 10);
  });

  it('prices sonnet, haiku, unknown claude models, and fable tiers', () => {
    const root = makeRoot();
    writeTranscript(root, 'project/session.jsonl', [
      transcriptLine('2026-07-10T11:30:00Z', 'claude-sonnet-5', { input_tokens: 1000, output_tokens: 1000 }),
      transcriptLine('2026-07-10T11:31:00Z', 'claude-haiku-5', { input_tokens: 1000, output_tokens: 1000 }),
      transcriptLine('2026-07-10T11:32:00Z', 'claude-unknown-model-1', { input_tokens: 1000, output_tokens: 1000 }),
    ]);

    expect(estimateTrailingSpend({ roots: [root], now })).toBeCloseTo(0.042, 10);
    expect(priceFor('claude-fable-5')).toEqual({ input: 15, output: 75 });
  });

  it('filters transcript lines to the trailing window', () => {
    const root = makeRoot();
    writeTranscript(root, 'project/session.jsonl', [
      transcriptLine('2026-07-10T06:00:00Z', 'claude-sonnet-5', { input_tokens: 1_000_000 }),
      transcriptLine('2026-07-10T12:00:00Z', 'claude-sonnet-5', { input_tokens: 1_000_000 }),
      transcriptLine('2026-07-10T12:00:01Z', 'claude-sonnet-5', { input_tokens: 1_000_000 }),
    ]);

    expect(estimateTrailingSpend({ roots: [root], now })).toBe(3);
  });

  it('excludes non-claude models', () => {
    const root = makeRoot();
    writeTranscript(root, 'project/session.jsonl', [
      transcriptLine('2026-07-10T11:30:00Z', 'gpt-5.2-codex', { input_tokens: 1_000_000 }),
    ]);

    expect(estimateTrailingSpend({ roots: [root], now })).toBe(0);
  });

  it('tolerates malformed input and defaults missing token fields to zero', () => {
    const root = makeRoot();
    writeTranscript(root, 'project/session.jsonl', [
      'not json but has "usage"',
      JSON.stringify({ timestamp: '2026-07-10T11:30:00Z', usage: { input_tokens: 1_000_000 } }),
      JSON.stringify({ message: { model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000 } } }),
      transcriptLine('2026-07-10T11:30:00Z', 'claude-sonnet-5', { output_tokens: 1_000_000 }),
    ]);

    expect(estimateTrailingSpend({ roots: [root], now })).toBe(15);
  });

  it('handles roots recursively and ignores nonexistent roots and non-jsonl files', () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    writeTranscript(rootA, 'project/session.jsonl', [
      transcriptLine('2026-07-10T11:30:00Z', 'claude-sonnet-5', { input_tokens: 1_000_000 }),
    ]);
    writeTranscript(rootB, 'project/nested/session.jsonl', [
      transcriptLine('2026-07-10T11:30:00Z', 'claude-haiku-5', { output_tokens: 1_000_000 }),
    ]);
    writeTranscript(rootB, 'project/ignored.txt', [
      transcriptLine('2026-07-10T11:30:00Z', 'claude-opus-5', { output_tokens: 1_000_000 }),
    ]);

    expect(estimateTrailingSpend({ roots: [join(rootA, 'missing'), rootA, rootB], now })).toBe(8);
  });

  it('skips stale transcript files by mtime before parsing', () => {
    const root = makeRoot();
    const file = writeTranscript(root, 'project/session.jsonl', [
      transcriptLine('2026-07-10T11:30:00Z', 'claude-sonnet-5', { input_tokens: 1_000_000 }),
    ]);
    const old = new Date('2026-07-10T06:59:59Z');
    utimesSync(file, old, old);

    expect(estimateTrailingSpend({ roots: [root], now })).toBe(0);
  });

  it('skips a root that exists but cannot be read as a directory', () => {
    const dir = mkdtemp();
    const notADir = join(dir, 'not-a-directory');
    // The root exists (existsSync passes) but readdirSync throws ENOTDIR — the
    // per-root try/catch must swallow it and continue rather than crashing.
    writeFileSync(notADir, 'contents');

    expect(estimateTrailingSpend({ roots: [notADir], now })).toBe(0);
  });

  it('skips a .jsonl entry that is a directory rather than a readable file', () => {
    const root = makeRoot();
    // A directory whose name ends in .jsonl passes the extension filter and the
    // mtime gate, but readFileSync throws EISDIR — the inner try/catch continues.
    const fakeFile = join(root, 'session.jsonl');
    mkdirSync(fakeFile, { recursive: true });
    utimesSync(fakeFile, now, now);
    // A real transcript alongside it still contributes so we prove the loop went on.
    writeTranscript(root, 'real/session.jsonl', [
      transcriptLine('2026-07-10T11:30:00Z', 'claude-sonnet-5', { input_tokens: 1_000_000 }),
    ]);

    expect(estimateTrailingSpend({ roots: [root], now })).toBe(3);
  });

  it('exposes the default transcript roots', () => {
    const roots = defaultTranscriptRoots();
    expect(roots).toHaveLength(2);
    expect(roots[0].endsWith('.claude/projects')).toBe(true);
    expect(roots[1].endsWith('.config/claude/projects')).toBe(true);
  });

  it('formats the usage report', () => {
    expect(formatUsageReport(187.4, 227)).toBe('trailing-5h usage ~= $187 = 83% of $227 cap');
    expect(formatUsageReport(0, 227)).toBe('trailing-5h usage ~= $0 = 0% of $227 cap');
  });
});

describe('readCostsFile', () => {
  it('returns zero entries and zero skipped when the file is missing', () => {
    const dir = mkdtemp();
    expect(readCostsFile(join(dir, 'costs.jsonl'))).toEqual({ entries: [], skipped: 0 });
  });

  it('parses valid lines and counts malformed JSON and wrong-shape lines as skipped', () => {
    const dir = mkdtemp();
    const file = join(dir, 'costs.jsonl');
    const valid: CostEntry = { ts: '2026-07-10T11:30:00Z', issue: '61', task: 'build', model: 'claude-sonnet-5', inputTokens: 100, outputTokens: 50, cost: 0.01 };
    writeFileSync(file, [
      JSON.stringify(valid),
      'not valid json {{{',
      JSON.stringify({ ts: '2026-07-10T11:31:00Z', task: 'build', cost: 'not-a-number' }),
    ].join('\n') + '\n');

    const result = readCostsFile(file);
    expect(result.entries).toEqual([valid]);
    expect(result.skipped).toBe(2);
  });

  it('handles a trailing newline without producing a phantom skipped line', () => {
    const dir = mkdtemp();
    const file = join(dir, 'costs.jsonl');
    const valid: CostEntry = { ts: '2026-07-10T11:30:00Z', issue: '61', task: 'build', model: 'claude-sonnet-5', inputTokens: 100, outputTokens: 50, cost: 0.01 };
    writeFileSync(file, JSON.stringify(valid) + '\n\n');
    expect(readCostsFile(file)).toEqual({ entries: [valid], skipped: 0 });
  });

  it('counts a line with non-numeric token fields as skipped instead of admitting it for aggregation', () => {
    const dir = mkdtemp();
    const file = join(dir, 'costs.jsonl');
    const valid: CostEntry = { ts: '2026-07-10T11:30:00Z', issue: '61', task: 'build', model: 'claude-sonnet-5', inputTokens: 100, outputTokens: 50, cost: 0.01 };
    const corruptTokens = { ts: '2026-07-10T11:31:00Z', issue: '62', task: 'build', model: 'gpt-5', inputTokens: '1000', outputTokens: 50, cost: 0.01 };
    writeFileSync(file, [JSON.stringify(valid), JSON.stringify(corruptTokens)].join('\n') + '\n');

    const result = readCostsFile(file);
    expect(result.entries).toEqual([valid]);
    expect(result.skipped).toBe(1);
  });
});

describe('aggregateCosts', () => {
  it('returns empty perIssue and zero totals for empty input', () => {
    expect(aggregateCosts([])).toEqual({ perIssue: [], total: { inputTokens: 0, outputTokens: 0, cost: 0 } });
  });

  it('sums per-issue, nests per-model, and computes a grand total, preserving first-seen issue order', () => {
    const entries: CostEntry[] = [
      { ts: 't1', issue: '61', task: 'build', model: 'claude-sonnet-5', inputTokens: 100, outputTokens: 50, cost: 0.01 },
      { ts: 't2', issue: '62', task: 'plan', model: 'gpt-5', inputTokens: 200, outputTokens: 100, cost: 0.02 },
      { ts: 't3', issue: '61', task: 'check', model: 'claude-sonnet-5', inputTokens: 10, outputTokens: 5, cost: 0.001 },
      { ts: 't4', issue: '61', task: 'ship', model: 'claude-haiku-5', inputTokens: 1, outputTokens: 1, cost: 0.0001 },
    ];

    const summary = aggregateCosts(entries);

    expect(summary.perIssue.map(r => r.issue)).toEqual(['61', '62']);

    const issue61 = summary.perIssue[0];
    expect(issue61.inputTokens).toBe(111);
    expect(issue61.outputTokens).toBe(56);
    expect(issue61.cost).toBeCloseTo(0.0111, 10);
    expect(issue61.perModel).toEqual([
      { model: 'claude-sonnet-5', inputTokens: 110, outputTokens: 55, cost: 0.011, tasks: 2 },
      { model: 'claude-haiku-5', inputTokens: 1, outputTokens: 1, cost: 0.0001, tasks: 1 },
    ]);

    const issue62 = summary.perIssue[1];
    expect(issue62).toEqual({
      issue: '62',
      inputTokens: 200,
      outputTokens: 100,
      cost: 0.02,
      perModel: [{ model: 'gpt-5', inputTokens: 200, outputTokens: 100, cost: 0.02, tasks: 1 }],
    });

    expect(summary.total.inputTokens).toBe(311);
    expect(summary.total.outputTokens).toBe(156);
    expect(summary.total.cost).toBeCloseTo(0.0311, 10);
  });

  it('defaults missing token fields to zero', () => {
    const entries = [
      { ts: 't1', issue: '61', task: 'build', model: 'claude-sonnet-5', cost: 0.01 } as CostEntry,
    ];
    const summary = aggregateCosts(entries);
    expect(summary.perIssue[0].inputTokens).toBe(0);
    expect(summary.perIssue[0].outputTokens).toBe(0);
  });
});

describe('watchUsage', () => {
  it('stops when the cap is reached mid-run', async () => {
    const events: Array<[string, string, string | number, string]> = [];
    const spends = [100, 180];
    const stopCalls: string[] = [];
    let sleepCalls = 0;

    await expect(watchUsage({
      cap: 227,
      stopAt: 0.75,
      pollMs: 180_000,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      estimateSpend: () => spends.shift()!,
      emitEvent: (...args) => {
        events.push(args);
      },
      setStop: file => {
        stopCalls.push(file);
      },
      sleep: async () => {
        sleepCalls++;
      },
    })).resolves.toBe('stopped');

    expect(stopCalls).toEqual(['/repo/.factory/STOP']);
    expect(events).toEqual([
      ['/repo/.factory/events.ndjson', 'watchdog', 'usage', 'usage watchdog armed: stop at 75% of $227 cap, poll 180s'],
      ['/repo/.factory/events.ndjson', 'usage-stop', 'usage', 'trailing-5h usage ~= $180 = 79% of $227 cap -- STOP set, lanes halt between issues'],
    ]);
    expect(sleepCalls).toBe(1);
  });

  it('keeps polling below the cap and aborts cleanly', async () => {
    const controller = new AbortController();
    const events: Array<[string, string, string | number, string]> = [];
    const stopCalls: string[] = [];
    let sleepCalls = 0;

    await expect(watchUsage({
      cap: 227,
      stopAt: 0.75,
      pollMs: 180_000,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      signal: controller.signal,
      estimateSpend: () => 10,
      emitEvent: (...args) => {
        events.push(args);
      },
      setStop: file => {
        stopCalls.push(file);
      },
      sleep: async () => {
        sleepCalls++;
        if (sleepCalls === 3) controller.abort();
      },
    })).resolves.toBe('aborted');

    expect(stopCalls).toEqual([]);
    expect(events.map(([, type]) => type)).toEqual(['watchdog']);
    expect(sleepCalls).toBe(3);
  });

  it('stops at the exact threshold', async () => {
    await expect(watchUsage({
      cap: 200,
      stopAt: 0.75,
      pollMs: 180_000,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      estimateSpend: () => 150,
      emitEvent: () => {},
      setStop: () => {},
      sleep: async () => {},
    })).resolves.toBe('stopped');
  });

  it('uses the real timer-based sleep between polls until aborted', async () => {
    const controller = new AbortController();
    let estimateCalls = 0;

    // No injected sleep: this exercises the module's real setTimeout-based
    // sleep, both its Promise path (first poll) and its already-aborted
    // fast-return path (second poll, after the abort).
    await expect(watchUsage({
      cap: 227,
      stopAt: 0.75,
      pollMs: 1,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      signal: controller.signal,
      estimateSpend: () => {
        estimateCalls++;
        if (estimateCalls >= 2) controller.abort();
        return 10;
      },
      emitEvent: () => {},
      setStop: () => {},
    })).resolves.toBe('aborted');

    expect(estimateCalls).toBe(2);
  });

  it('formats the armed event', async () => {
    const controller = new AbortController();
    const events: Array<[string, string, string | number, string]> = [];

    await watchUsage({
      cap: 227,
      stopAt: 0.75,
      pollMs: 180_000,
      stopFile: '/repo/.factory/STOP',
      eventsFile: '/repo/.factory/events.ndjson',
      signal: controller.signal,
      estimateSpend: () => 10,
      emitEvent: (...args) => {
        events.push(args);
      },
      setStop: () => {},
      sleep: async () => {
        controller.abort();
      },
    });

    expect(events[0]).toEqual([
      '/repo/.factory/events.ndjson',
      'watchdog',
      'usage',
      'usage watchdog armed: stop at 75% of $227 cap, poll 180s',
    ]);
  });
});
