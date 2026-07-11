import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  estimateTrailingSpend,
  formatUsageReport,
  priceFor,
} from './index.js';

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

  it('formats the usage report', () => {
    expect(formatUsageReport(187.4, 227)).toBe('trailing-5h usage ~= $187 = 83% of $227 cap');
    expect(formatUsageReport(0, 227)).toBe('trailing-5h usage ~= $0 = 0% of $227 cap');
  });
});
