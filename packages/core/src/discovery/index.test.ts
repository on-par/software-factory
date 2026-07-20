import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_MAX_CANDIDATES, runDiscoveryScan } from './index.js';

const FIXED_NOW = () => new Date('2026-07-20T00:00:00Z');

function stubRun(stdout: string, ok: boolean) {
  return async () => ({ stdout, ok });
}

function openIssueRun(titles: string[]) {
  return stubRun(JSON.stringify(titles.map((title) => ({ title }))), true);
}

function recordingRun(recorded: (readonly string[])[], titles: string[] = []) {
  return async (argv: readonly string[]) => {
    recorded.push(argv);
    return { stdout: JSON.stringify(titles.map((title) => ({ title }))), ok: true };
  };
}

describe('runDiscoveryScan', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'discovery-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFixtures(): void {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Product\n\n## Observability\n\nWe care about observability.\n');
    writeFileSync(join(dir, 'ROADMAP.md'), '- Improve observability dashboards\n- Ship a new export button\n');
    writeFileSync(join(dir, 'FEEDBACK.md'), '- Users want faster search\n');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'foo.ts'),
      ['// TODO: refactor the router failover path', 'const x = 1;', '// FIXME: flaky test'].join('\n'),
    );
    mkdirSync(join(dir, '.factory'), { recursive: true });
    writeFileSync(
      join(dir, '.factory', 'fingerprints.json'),
      JSON.stringify({
        themes: [
          { key: 'lint-timeout', label: 'lint checker times out', count: 4 },
          { key: 'rare', label: 'one-off glitch', count: 1 },
        ],
      }),
    );
  }

  it('grounds every candidate in at least one concrete signal', async () => {
    writeFixtures();
    const result = await runDiscoveryScan(
      { repoDir: dir },
      { now: FIXED_NOW, run: openIssueRun(['Existing: flaky test suite']) },
    );

    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.signals.length).toBeGreaterThanOrEqual(1);
      for (const signal of candidate.signals) {
        expect(['constitution', 'roadmap', 'code-todo', 'feedback', 'bug-theme']).toContain(signal.source);
      }
    }

    const todoCandidate = result.candidates.find((c) => c.signals[0].source === 'code-todo');
    expect(todoCandidate?.signals[0].reference).toMatch(/^src\/foo\.ts:\d+$/);

    const bugThemeCandidate = result.candidates.find((c) => c.signals[0].source === 'bug-theme');
    expect(bugThemeCandidate?.signals[0].count).toBe(4);

    // The count:1 theme must not produce a candidate.
    expect(result.candidates.some((c) => c.hypothesis.includes('one-off glitch'))).toBe(false);
  });

  it('ranks and caps candidates, recurring bug-theme first', async () => {
    writeFixtures();
    const result = await runDiscoveryScan(
      { repoDir: dir, maxCandidates: 2 },
      { now: FIXED_NOW, run: openIssueRun(['Existing: flaky test suite']) },
    );

    expect(result.candidates).toHaveLength(2);
    for (let i = 1; i < result.candidates.length; i++) {
      expect(result.candidates[i - 1].score).toBeGreaterThanOrEqual(result.candidates[i].score);
    }
    expect(result.candidates[0].signals[0].source).toBe('bug-theme');
    expect(result.candidates[0].score).toBe(8);
  });

  it('boosts and grounds candidates whose detail matches the north-star keywords', async () => {
    writeFixtures();
    const result = await runDiscoveryScan(
      { repoDir: dir, maxCandidates: 20 },
      { now: FIXED_NOW, run: openIssueRun([]) },
    );

    const boosted = result.candidates.find((c) => c.hypothesis.includes('observability dashboards'));
    expect(boosted).toBeDefined();
    expect(boosted?.signals.some((s) => s.source === 'constitution')).toBe(true);

    const baseline = result.candidates.find((c) => c.hypothesis.includes('export button'));
    expect(baseline).toBeDefined();
    expect(boosted!.score).toBeGreaterThan(baseline!.score);
  });

  it('suppresses candidates sharing a significant token with an open issue title', async () => {
    writeFixtures();
    const withoutSuppression = await runDiscoveryScan(
      { repoDir: dir, maxCandidates: 20 },
      { now: FIXED_NOW, run: openIssueRun([]) },
    );
    expect(withoutSuppression.candidates.some((c) => c.hypothesis.includes('faster search'))).toBe(true);

    const withSuppression = await runDiscoveryScan(
      { repoDir: dir, maxCandidates: 20 },
      { now: FIXED_NOW, run: openIssueRun(['Make search faster for large repos']) },
    );
    expect(withSuppression.candidates.some((c) => c.hypothesis.includes('faster search'))).toBe(false);
  });

  it('never issues a write command, only gh issue list', async () => {
    writeFixtures();
    const recorded: (readonly string[])[] = [];
    await runDiscoveryScan({ repoDir: dir }, { now: FIXED_NOW, run: recordingRun(recorded) });

    expect(recorded.length).toBeGreaterThan(0);
    for (const argv of recorded) {
      expect(argv.slice(0, 3)).toEqual(['gh', 'issue', 'list']);
      const joined = argv.join(' ');
      expect(joined).not.toMatch(/\b(create|edit|close|comment|delete|merge|push|commit|reopen|label)\b/);
    }
  });

  it('handles an empty repo gracefully', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'discovery-empty-'));
    try {
      const result = await runDiscoveryScan({ repoDir: emptyDir }, { now: FIXED_NOW, run: stubRun('', false) });
      expect(result.candidates).toEqual([]);
      expect(result.signalsCollected).toBe(0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('tolerates a failing gh call while still returning candidates from other signals', async () => {
    writeFixtures();
    const result = await runDiscoveryScan(
      { repoDir: dir, maxCandidates: 20 },
      { now: FIXED_NOW, run: stubRun('', false) },
    );
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('honors the maxCandidates cap edges', async () => {
    writeFixtures();
    const zeroCap = await runDiscoveryScan(
      { repoDir: dir, maxCandidates: 0 },
      { now: FIXED_NOW, run: openIssueRun([]) },
    );
    expect(zeroCap.candidates).toHaveLength(0);

    const defaultCap = await runDiscoveryScan({ repoDir: dir }, { now: FIXED_NOW, run: openIssueRun([]) });
    expect(defaultCap.candidates.length).toBeLessThanOrEqual(DEFAULT_MAX_CANDIDATES);
  });

  it('resolves without throwing when called with no deps object', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'discovery-nodeps-'));
    try {
      await expect(runDiscoveryScan({ repoDir: emptyDir })).resolves.toBeDefined();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('returns [] for an invalid .factory/fingerprints.json', async () => {
    mkdirSync(join(dir, '.factory'), { recursive: true });
    writeFileSync(join(dir, '.factory', 'fingerprints.json'), 'not json{{{');
    const result = await runDiscoveryScan({ repoDir: dir }, { now: FIXED_NOW, run: openIssueRun([]) });
    expect(result.candidates.some((c) => c.signals[0].source === 'bug-theme')).toBe(false);
  });

  it('returns [] titles for malformed gh stdout', async () => {
    writeFixtures();
    const result = await runDiscoveryScan(
      { repoDir: dir, maxCandidates: 20 },
      { now: FIXED_NOW, run: stubRun('not json', true) },
    );
    // Malformed gh output degrades to an empty suppression set — nothing is dropped.
    expect(result.candidates.some((c) => c.hypothesis.includes('faster search'))).toBe(true);
  });

  it('parses numbered and checkbox roadmap items', async () => {
    writeFileSync(
      join(dir, 'ROADMAP.md'),
      '1. Numbered roadmap item\n- [ ] Checkbox roadmap item\n- [x] Done roadmap item\n',
    );
    const result = await runDiscoveryScan(
      { repoDir: dir, maxCandidates: 20 },
      { now: FIXED_NOW, run: openIssueRun([]) },
    );
    expect(result.candidates.some((c) => c.hypothesis.includes('Numbered roadmap item'))).toBe(true);
    expect(result.candidates.some((c) => c.hypothesis.includes('Checkbox roadmap item'))).toBe(true);
    expect(result.candidates.some((c) => c.hypothesis.includes('Done roadmap item'))).toBe(true);
  });
});
