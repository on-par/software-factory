import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderLocalRunReport, writeLocalRunReport } from './local-run.js';

let tmpDir: string | undefined;

describe('local-only run reports', () => {
  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('renders model attempts, changed files, verification, and failures', () => {
    const markdown = renderLocalRunReport({
      issue: 137,
      profile: 'local-only',
      outcome: 'failed',
      route: 'codex',
      branch: 'local-test/137-docs',
      worktree: '/repo-factory-137',
      specPath: '/repo/.factory/plans/issue-137.md',
      startedAt: '2026-07-14T02:27:00.000Z',
      reportTime: '2026-07-14T02:30:00.000Z',
      reason: 'empty_response',
      changedFiles: ['M AGENTS.md'],
      diffStat: 'AGENTS.md | 20 ++++++++++++++++++++',
      events: [
        {
          ts: '2026-07-14T02:27:23.000Z',
          issue: '137',
          type: 'router',
          msg: 'Trying qwen2.5-coder:14b for plan (attempt 1)',
        },
        {
          ts: '2026-07-14T02:28:11.000Z',
          issue: '137',
          type: 'plan',
          msg: 'Plan complete with model qwen2.5-coder:14b, route: codex',
        },
        {
          ts: '2026-07-14T02:28:12.000Z',
          issue: '137',
          type: 'router',
          msg: 'Trying codex-ollama-qwen3.5:9b for build_codex (attempt 1)',
        },
        {
          ts: '2026-07-14T02:29:20.000Z',
          issue: '137',
          type: 'router',
          msg: 'codex-ollama-qwen3.5:9b failed (empty_response) on build_codex',
        },
        {
          ts: '2026-07-14T02:29:20.000Z',
          issue: '137',
          type: 'router',
          msg: 'local command-agent trace: local command-agent malformed output (empty_response); trace written to .factory/local-agent-traces/trace.json; retry prompt .factory/local-agent-traces/repair.md',
        },
        { ts: '2026-07-14T02:29:20.000Z', issue: '137', type: 'fail', msg: "All models failed for task 'build_codex'" },
      ],
    });

    expect(markdown).toContain('# Local-only run report: issue #137');
    expect(markdown).toContain('- Outcome: failed');
    expect(markdown).toContain('- qwen2.5-coder:14b for plan, attempt 1');
    expect(markdown).toContain('- codex-ollama-qwen3.5:9b for build_codex, attempt ?: empty_response');
    expect(markdown).toContain('- M AGENTS.md');
    expect(markdown).toContain('AGENTS.md | 20 ++++++++++++++++++++');
    expect(markdown).toContain('trace written to .factory/local-agent-traces/trace.json');
    expect(markdown).toContain("All models failed for task 'build_codex'");
  });

  it('renders empty-state sections when there are no events or changes', () => {
    const markdown = renderLocalRunReport({
      issue: 300,
      profile: 'local-only',
      outcome: 'parked',
      startedAt: '2026-07-14T02:27:00.000Z',
      reportTime: '2026-07-14T02:30:00.000Z',
      changedFiles: [],
      diffStat: '',
      events: [],
    });

    expect(markdown).toContain('- Route: unknown');
    expect(markdown).toContain('- Branch: unknown');
    expect(markdown).not.toContain('- Reason:');
    expect(markdown).toContain('- No model attempts recorded.');
    expect(markdown).toContain('- No changed files recorded.');
    expect(markdown).toContain('No diff against origin/main.');
    expect(markdown).toContain('- No verification events recorded.');
    expect(markdown).toContain('- None recorded.');
    expect(markdown).toContain('- No events recorded for this run window.');
    // commandObservations default guidance when no command-level events exist.
    expect(markdown).toContain('No command-level observations were captured');
  });

  it('surfaces command observations captured in the event log', () => {
    const markdown = renderLocalRunReport({
      issue: 301,
      profile: 'local-only',
      outcome: 'ready',
      startedAt: '2026-07-14T02:27:00.000Z',
      reportTime: '2026-07-14T02:30:00.000Z',
      changedFiles: [],
      diffStat: '',
      events: [{ ts: '2026-07-14T02:28:00.000Z', issue: '301', type: 'router', msg: '$ npm test' }],
    });

    expect(markdown).toContain('- router: $ npm test');
    expect(markdown).not.toContain('No command-level observations were captured');
  });

  it('degrades gracefully when git commands throw and event lines are malformed', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-local-report-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const reportsDir = join(tmpDir, 'reports');
    const worktree = join(tmpDir, 'worktree');
    await mkdir(worktree);
    writeFileSync(
      eventsFile,
      [
        '{ this is not valid json',
        JSON.stringify({
          ts: '2026-07-14T02:28:11.000Z',
          issue: '137',
          type: 'ready',
          msg: 'PR #200 ready for review',
        }),
      ].join('\n'),
    );

    const report = await writeLocalRunReport(
      {
        issue: 137,
        eventsFile,
        reportsDir,
        startedAt: '2026-07-14T02:27:00.000Z',
        outcome: 'ready',
        profile: 'local-only',
        worktree,
      },
      {
        now: () => new Date('2026-07-14T02:30:00.000Z'),
        run: async () => {
          throw new Error('git failed');
        },
      },
    );

    const written = readFileSync(report.path, 'utf-8');
    // Malformed line is skipped; the valid one survives.
    expect(written).toContain('PR #200 ready for review');
    // Both git-backed sections fall back to their empty states after the throw.
    expect(written).toContain('- No changed files recorded.');
    expect(written).toContain('No diff against origin/main.');
  });

  it('writes a report for only the current run window', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-local-report-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const reportsDir = join(tmpDir, 'reports');
    const worktree = join(tmpDir, 'worktree');
    await mkdir(worktree);
    writeFileSync(
      eventsFile,
      [
        JSON.stringify({
          ts: '2026-07-14T02:00:00.000Z',
          issue: '137',
          type: 'router',
          msg: 'Trying stale-model for plan (attempt 1)',
        }),
        JSON.stringify({
          ts: '2026-07-14T02:27:23.000Z',
          issue: '137',
          type: 'router',
          msg: 'Trying qwen2.5-coder:14b for plan (attempt 1)',
        }),
        JSON.stringify({
          ts: '2026-07-14T02:28:11.000Z',
          issue: '137',
          type: 'ready',
          msg: 'PR #200 ready for review',
        }),
        JSON.stringify({
          ts: '2026-07-14T02:28:11.000Z',
          issue: '138',
          type: 'ready',
          msg: 'PR #201 ready for review',
        }),
      ].join('\n'),
    );

    const report = await writeLocalRunReport(
      {
        issue: 137,
        eventsFile,
        reportsDir,
        startedAt: '2026-07-14T02:27:00.000Z',
        outcome: 'ready',
        profile: 'local-only',
        route: 'codex',
        worktree,
        specPath: join(tmpDir, 'plans', 'issue-137.md'),
      },
      {
        now: () => new Date('2026-07-14T02:30:00.000Z'),
        run: async (command) => {
          if (command === 'git status --short') return { stdout: '', stderr: '' };
          return { stdout: 'AGENTS.md | 4 ++++\n', stderr: '' };
        },
      },
    );

    expect(report.path).toBe(join(reportsDir, '2026-07-14T02-30-00-000Z-issue-137-ready.md'));
    expect(existsSync(report.path)).toBe(true);
    const written = readFileSync(report.path, 'utf-8');
    expect(written).toContain('qwen2.5-coder:14b');
    expect(written).not.toContain('stale-model');
    expect(written).not.toContain('PR #201');
    expect(written).toContain('PR #200 ready for review');
  });
});
