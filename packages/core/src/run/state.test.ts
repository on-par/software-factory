import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { clearRepoSlugCache } from '../logger/repo-slug.js';
import type { IssueRunState } from '../types/index.js';
import { readIssueRunState, runStateFile, writeIssueRunState } from './state.js';

function initGitRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'ssh://git@ssh.github.com:443/on-par/sound-buddy.git'], {
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
      expect(persisted.repo).toBe('on-par/sound-buddy');
      expect(persisted.lane).toBe('lane-2');
      expect(returned.repo).toBe('on-par/sound-buddy');
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

      expect(read?.repo).toBe('on-par/sound-buddy');
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
});
