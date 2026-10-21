import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { clearRepoSlugCache } from '../logger/repo-slug.js';
import type { IssueRunState } from '../types/index.js';
import {
  nextIssueRunState,
  readIssueRunState,
  runStateFile,
  runStatusForPhase,
  terminalRunStatus,
  writeIssueRunState,
  type IssueRunStateBase,
} from './state.js';

function initGitRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'ssh://git@ssh.github.com:443/owner/example-app.git'], {
    cwd: dir,
  });
}

function fixtureState(worktree: string, overrides: Partial<IssueRunState> = {}): IssueRunState {
  return {
    issue: 972,
    lane: 'lane-2',
    status: 'building',
    branch: 'ship-it/972-x',
    worktree,
    specPath: '.factory/state/plans/issue-972.md',
    model: 'claude-sonnet-5',
    route: 'codex',
    attempts: 1,
    startedAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('run/state', () => {
  beforeEach(() => {
    clearRepoSlugCache();
  });

  describe('runStateFile', () => {
    it('names the file issue-<n>.json inside runsDir', () => {
      expect(runStateFile('/tmp/runs', 972)).toBe('/tmp/runs/issue-972.json');
    });
  });

  describe('writeIssueRunState', () => {
    it('resolves and persists the repo slug from the worktree, into a not-yet-created directory', async () => {
      const worktree = mkdtempSync(join(tmpdir(), 'run-state-worktree-'));
      initGitRepo(worktree);
      const runsDir = join(mkdtempSync(join(tmpdir(), 'run-state-runs-')), 'nested', 'runs');
      const file = runStateFile(runsDir, 972);

      const returned = await writeIssueRunState(file, fixtureState(worktree));

      const persisted = JSON.parse(readFileSync(file, 'utf-8')) as IssueRunState;
      expect(persisted.repo).toBe('owner/example-app');
      expect(persisted.lane).toBe('lane-2');
      expect(returned.repo).toBe('owner/example-app');
    });

    it('writes the caller-supplied repo verbatim, without resolving the worktree', async () => {
      const worktree = mkdtempSync(join(tmpdir(), 'run-state-worktree-'));
      initGitRepo(worktree);
      const runsDir = mkdtempSync(join(tmpdir(), 'run-state-runs-'));
      const file = runStateFile(runsDir, 972);

      const returned = await writeIssueRunState(file, fixtureState(worktree, { repo: 'acme/widgets' }));

      const persisted = JSON.parse(readFileSync(file, 'utf-8')) as IssueRunState;
      expect(persisted.repo).toBe('acme/widgets');
      expect(returned.repo).toBe('acme/widgets');
    });

    it('omits the repo key entirely when the slug cannot be resolved, without throwing', async () => {
      const worktree = mkdtempSync(join(tmpdir(), 'run-state-worktree-'));
      const runsDir = mkdtempSync(join(tmpdir(), 'run-state-runs-'));
      const file = runStateFile(runsDir, 972);

      const returned = await writeIssueRunState(file, fixtureState(worktree));

      const persisted = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
      expect('repo' in persisted).toBe(false);
      expect(returned.repo).toBeUndefined();
    });
  });

  describe('readIssueRunState', () => {
    it('round-trips a written record with repo present', async () => {
      const worktree = mkdtempSync(join(tmpdir(), 'run-state-worktree-'));
      initGitRepo(worktree);
      const runsDir = mkdtempSync(join(tmpdir(), 'run-state-runs-'));
      const file = runStateFile(runsDir, 972);
      await writeIssueRunState(file, fixtureState(worktree));

      const read = await readIssueRunState(file);

      expect(read?.repo).toBe('owner/example-app');
      expect(read?.lane).toBe('lane-2');
      expect(read?.issue).toBe(972);
      expect(read?.branch).toBe('ship-it/972-x');
    });

    it('reads a legacy record with no repo field back with repo undefined', async () => {
      const runsDir = mkdtempSync(join(tmpdir(), 'run-state-runs-'));
      const file = runStateFile(runsDir, 972);
      const legacy = fixtureState('/nonexistent');
      writeFileSync(file, JSON.stringify(legacy));

      const read = await readIssueRunState(file);

      expect(read?.repo).toBeUndefined();
      expect(read?.lane).toBe('lane-2');
      expect(read?.issue).toBe(972);
    });

    it('returns null for a missing file, malformed JSON, and array JSON, never throwing', async () => {
      const runsDir = mkdtempSync(join(tmpdir(), 'run-state-runs-'));

      await expect(readIssueRunState(join(runsDir, 'missing.json'))).resolves.toBeNull();

      const badJsonFile = join(runsDir, 'bad.json');
      writeFileSync(badJsonFile, 'not json');
      await expect(readIssueRunState(badJsonFile)).resolves.toBeNull();

      const arrayJsonFile = join(runsDir, 'array.json');
      writeFileSync(arrayJsonFile, '[]');
      await expect(readIssueRunState(arrayJsonFile)).resolves.toBeNull();
    });
  });

  describe('runStatusForPhase', () => {
    it('maps all four phases', () => {
      expect((['plan', 'build', 'check', 'ship'] as const).map(runStatusForPhase)).toEqual([
        'planning',
        'building',
        'checking',
        'shipping',
      ]);
    });
  });

  describe('terminalRunStatus', () => {
    it('maps every outcome state', () => {
      const route = 'claude' as const;
      expect(terminalRunStatus({ state: 'ready', route, branch: 'b', reworkRounds: 0 })).toBe('ready');
      expect(terminalRunStatus({ state: 'shipped', route, branch: 'b', reworkRounds: 0, prNumber: 1 })).toBe('ready');
      expect(terminalRunStatus({ state: 'parked', reason: 'fail' })).toBe('parked');
      expect(terminalRunStatus({ state: 'escalated', reason: 'x' })).toBe('escalated');
      expect(
        terminalRunStatus({
          state: 'released',
          reason: 'environment',
          reworkRounds: 0,
          baseSha: 's',
          failingChecks: [],
        }),
      ).toBe('pending');
    });
  });

  describe('nextIssueRunState', () => {
    const base: IssueRunStateBase = {
      issue: 42,
      lane: 'bugfix',
      branch: 'factory/42-fix',
      worktree: '/w',
      specPath: '/s.md',
      startedAt: '2026-01-01T00:00:00.000Z',
    };

    it('fills defaults on the first write and omits absent keys', () => {
      const next = nextIssueRunState(undefined, base, { status: 'planning' }, '2026-01-01T00:00:01.000Z');
      expect(next).toMatchObject({
        status: 'planning',
        branch: 'factory/42-fix',
        route: 'claude',
        model: '',
        attempts: 1,
        startedAt: base.startedAt,
        updatedAt: '2026-01-01T00:00:01.000Z',
      });
      expect(Object.keys(next)).not.toContain('prNumber');
      expect(Object.keys(next)).not.toContain('failures');
      expect(Object.values(next)).not.toContain(undefined);
    });

    it('keeps the previous model and prNumber, drops failures, and keeps startedAt', () => {
      const failure = { checker: 'tests', result: 'FAIL' as const, details: 'x' };
      const first = nextIssueRunState(
        undefined,
        base,
        { status: 'parked', model: 'm', prNumber: 7, failures: [failure] },
        't1',
      );
      expect(first.failures).toEqual([failure]);
      const second = nextIssueRunState(first, base, { status: 'checking' }, 't2');
      expect(second).toMatchObject({
        status: 'checking',
        model: 'm',
        prNumber: 7,
        startedAt: base.startedAt,
        updatedAt: 't2',
      });
      expect(Object.keys(second)).not.toContain('failures');
    });

    it('carries prev.steers forward (#3400)', () => {
      const steer = {
        ts: '2026-10-20T12:00:00.000Z',
        actor: 'octocat',
        source: 'cli' as const,
        phase: 'build' as const,
        summary: 'nudge',
      };
      const first = { ...nextIssueRunState(undefined, base, { status: 'building' }, 't1'), steers: [steer] };
      const second = nextIssueRunState(first, base, { status: 'checking' }, 't2');
      expect(second.steers).toEqual([steer]);
      const plain = nextIssueRunState(undefined, base, { status: 'building' }, 't1');
      expect(Object.keys(nextIssueRunState(plain, base, { status: 'checking' }, 't2'))).not.toContain('steers');
    });
  });
});
