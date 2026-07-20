import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CheckSummary, FactoryEvent } from '../types/index.js';
import { gatherEvidencePack, renderEvidencePack } from './evidence-pack.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function mkdtemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-evidence-pack-'));
  tempDirs.push(dir);
  return dir;
}

const checkSummary: CheckSummary = {
  failures: 1,
  passes: 1,
  skips: 1,
  total: 3,
  results: [
    { checker: 'compile', result: 'PASS', details: 'build succeeded' },
    { checker: 'tests', result: 'FAIL', details: 'x'.repeat(300) },
    { checker: 'links', result: 'SKIP', details: 'no links checker configured' },
  ],
};

const events: FactoryEvent[] = [
  { ts: '2026-07-20T10:00:00Z', type: 'rework', issue: '385', msg: 'sending back to worker (round 1)' },
  { ts: '2026-07-20T10:05:00Z', type: 'check', issue: '385', msg: 'all checkers passed' },
  { ts: '2026-07-20T10:06:00Z', type: 'ship', issue: '385', msg: 'Starting ship phase' },
];

describe('renderEvidencePack', () => {
  it('renders a full pack with checker verdicts, spec summary, rework, timeline, and logs', () => {
    const markdown = renderEvidencePack({
      issue: 385,
      checkSummary,
      reworkRounds: 2,
      specSummary: 'Attach an evidence pack to every PR.',
      events,
      logFiles: ['issue-385.build.log', 'issue-385.check.log'],
    });

    expect(markdown).toContain('## 🔎 Evidence pack');
    expect(markdown).toContain('Checkers: 1 pass, 1 fail, 1 skip');
    expect(markdown).toContain('Rework rounds: 2');
    expect(markdown).toContain('✅ PASS `compile`');
    expect(markdown).toContain('❌ FAIL `tests`');
    expect(markdown).toContain('⚪ SKIP `links`');
    expect(markdown).toContain('Attach an evidence pack to every PR.');
    for (const event of events) {
      expect(markdown).toContain(`${event.type}: ${event.msg}`);
    }
    expect(markdown).toContain('issue-385.build.log');
    expect(markdown).toContain('issue-385.check.log');
    expect(markdown.match(/<details>/g)?.length).toBe(5);
    expect(markdown.match(/<\/details>/g)?.length).toBe(5);
  });

  it('truncates long checker details to ~200 characters', () => {
    const markdown = renderEvidencePack({
      issue: 385,
      checkSummary,
      events: [],
      logFiles: [],
    });
    const failLine = markdown.split('\n').find((line) => line.includes('FAIL `tests`'));
    expect(failLine).toBeDefined();
    expect(failLine!.length).toBeLessThan(250);
    expect(failLine).toContain('…');
  });

  it('falls back cleanly when checkSummary, events, logFiles, and specSummary are all absent', () => {
    const markdown = renderEvidencePack({
      issue: 385,
      events: [],
      logFiles: [],
    });

    expect(markdown).toContain('## 🔎 Evidence pack');
    expect(markdown).toContain('No verification data available.');
    expect(markdown).toContain('No checker results recorded.');
    expect(markdown).toContain('Spec summary unavailable.');
    expect(markdown).toContain('No events recorded for this run window.');
    expect(markdown).toContain('No per-issue log files found; see the event timeline above.');
    expect(markdown.length).toBeGreaterThan(0);
  });

  it('preserves rework rounds and shows a final passed verdict when failures are zero (AC-2)', () => {
    const markdown = renderEvidencePack({
      issue: 385,
      checkSummary: { failures: 0, passes: 3, skips: 0, total: 3, results: [] },
      reworkRounds: 1,
      events,
      logFiles: [],
    });

    expect(markdown).toContain('Rework rounds: 1');
    expect(markdown).toContain('rework: sending back to worker (round 1)');
    expect(markdown).toContain('Final result: all checkers passed');
  });

  it('shows the remaining failure count in the final verdict when failures are non-zero', () => {
    const markdown = renderEvidencePack({
      issue: 385,
      checkSummary,
      events: [],
      logFiles: [],
    });

    expect(markdown).toContain('Final result: 1 failure(s) remain');
  });
});

describe('gatherEvidencePack', () => {
  it('reads a spec file, extracts the Goal section, filters events, and lists matching log files', () => {
    const dir = mkdtemp();
    const specPath = join(dir, 'issue-7.md');
    writeFileSync(
      specPath,
      [
        '---',
        'route: codex',
        '---',
        '# Spec: something (#7)',
        '',
        '## Goal',
        'Make the widget spin faster than before.',
        '',
        '## Files',
        'not part of the goal',
        '',
      ].join('\n'),
    );

    const eventsFile = join(dir, 'events.ndjson');
    writeFileSync(
      eventsFile,
      [
        JSON.stringify({ ts: '2026-07-20T09:00:00Z', type: 'plan', issue: '7', msg: 'planning' }),
        JSON.stringify({ ts: '2026-07-20T09:05:00Z', type: 'check', issue: '7', msg: 'checked' }),
        JSON.stringify({ ts: '2026-07-20T09:06:00Z', type: 'plan', issue: '9', msg: 'other issue' }),
      ].join('\n'),
    );

    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir);
    writeFileSync(join(logsDir, 'issue-7.build.log'), 'log contents');
    writeFileSync(join(logsDir, 'issue-70.build.log'), 'unrelated issue');
    writeFileSync(join(logsDir, 'other.log'), 'unrelated file');

    const markdown = gatherEvidencePack({
      issue: 7,
      specPath,
      eventsFile,
      startedAt: '2026-07-20T08:00:00Z',
      logsDir,
    });

    expect(markdown).toContain('Make the widget spin faster than before.');
    expect(markdown).not.toContain('not part of the goal');
    expect(markdown).toContain('check: checked');
    expect(markdown).not.toContain('other issue');
    expect(markdown).toContain('issue-7.build.log');
    expect(markdown).not.toContain('issue-70.build.log');
    expect(markdown).not.toContain('other.log');
  });

  it('falls back cleanly with no throw when all optional paths are omitted', () => {
    expect(() => gatherEvidencePack({ issue: 385 })).not.toThrow();
    const markdown = gatherEvidencePack({ issue: 385 });
    expect(markdown).toContain('## 🔎 Evidence pack');
    expect(markdown).toContain('Spec summary unavailable.');
  });

  it('uses the leading body excerpt when the spec has no Goal section', () => {
    const dir = mkdtemp();
    const specPath = join(dir, 'issue-8.md');
    writeFileSync(specPath, '# Spec: no goal section\n\nJust some body text describing the change.\n');

    const markdown = gatherEvidencePack({ issue: 8, specPath });

    expect(markdown).toContain('Just some body text describing the change.');
  });
});
