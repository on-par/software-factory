import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { schemaErrorCheckerOutput } from '../checkers/index.js';
import { writeSpec } from '../spec/index.js';
import { workKeyFromIssue } from '../work/work-key.js';
import {
  checkResumePath,
  checkResumeBaseDrift,
  createCheckResumeStore,
  createPlanReuseStore,
  formatBaseMovedRefusal,
  formatPreservedBuildMessage,
  issueBodyHash,
  planReusePath,
  configParkMessage,
  preservedFixTarget,
  type CheckResumeRecord,
  type PlanReuseRecord,
} from './resume-context.js';
import type { Constitution } from '../types/index.js';

const DESIGN = {
  restatedProblem: 'problem',
  approach: { chosen: 'chosen', rejected: [] },
  interfacesTouched: [],
  targetTypes: [],
  signatures: [],
  callGraph: [],
  behaviorContract: [],
  verificationPlan: [],
  riskBlastRadius: 'low',
  openQuestions: [],
};

const record = (bodyHash: string): PlanReuseRecord => ({
  bodyHash,
  baseSha: 'abc',
  route: 'claude',
  releasedAt: '2026-01-01T00:00:00.000Z',
});

describe('issueBodyHash / planReusePath', () => {
  it('is stable, ignores CRLF and outer whitespace, and differs per body', () => {
    expect(issueBodyHash('a\nb')).toBe(issueBodyHash('a\nb'));
    expect(issueBodyHash('a\r\nb')).toBe(issueBodyHash('  a\nb\n'));
    expect(issueBodyHash('a')).not.toBe(issueBodyHash('b'));
  });

  it('maps the spec path to its resume sidecar', () => {
    expect(planReusePath('/x/issue-7.md')).toBe('/x/issue-7.resume.json');
    expect(planReusePath('/x/issue-7')).toBe('/x/issue-7.resume.json');
  });
});

describe('createPlanReuseStore', () => {
  let dir: string;
  let specPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'resume-context-'));
    specPath = join(dir, 'issue-7.md');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('record then load rebuilds the PlanResult from the frozen spec', async () => {
    await writeSpec(specPath, { body: '# spec', data: { route: 'claude', design: DESIGN } });
    const store = createPlanReuseStore(specPath);
    await store.record(record('h1'));
    expect(await store.load('h1')).toMatchObject({
      ok: true,
      route: 'claude',
      model: 'plan-reused',
      specPath,
      designArtifact: expect.anything(),
    });
  });

  it('yields a null designArtifact when the spec has no design block', async () => {
    await writeSpec(specPath, { body: '# spec', data: { route: 'claude' } });
    const store = createPlanReuseStore(specPath);
    await store.record(record('h1'));
    expect(await store.load('h1')).toMatchObject({ designArtifact: null });
  });

  it('returns null when there is no record', async () => {
    await writeSpec(specPath, { body: '# spec', data: { route: 'claude' } });
    expect(await createPlanReuseStore(specPath).load('h1')).toBeNull();
  });

  it('returns null when the hash differs', async () => {
    await writeSpec(specPath, { body: '# spec', data: { route: 'claude' } });
    const store = createPlanReuseStore(specPath);
    await store.record(record('h1'));
    expect(await store.load('h2')).toBeNull();
  });

  it.each(['{not json', '{"baseSha":"x"}', 'null'])('returns null for an unusable record %s', async (content) => {
    await writeSpec(specPath, { body: '# spec', data: { route: 'claude' } });
    await writeFile(planReusePath(specPath), content);
    expect(await createPlanReuseStore(specPath).load('h1')).toBeNull();
  });

  it('returns null when the spec is missing', async () => {
    const store = createPlanReuseStore(specPath);
    await store.record(record('h1'));
    expect(await store.load('h1')).toBeNull();
  });

  it('returns null when the spec route is invalid', async () => {
    await writeSpec(specPath, { body: '# spec', data: { route: 'bogus' } });
    const store = createPlanReuseStore(specPath);
    await store.record(record('h1'));
    expect(await store.load('h1')).toBeNull();
  });

  it('rethrows a non-ENOENT read error', async () => {
    await mkdir(planReusePath(specPath));
    await expect(createPlanReuseStore(specPath).load('h1')).rejects.toThrow(/EISDIR/);
  });

  it('rethrows a non-ENOENT spec read error', async () => {
    await mkdir(specPath);
    const store = createPlanReuseStore(specPath);
    await store.record(record('h1'));
    await expect(store.load('h1')).rejects.toThrow(/EISDIR/);
  });

  it('record creates a missing parent dir; clear deletes and is idempotent', async () => {
    const nested = join(dir, 'a', 'b', 'issue-7.md');
    const store = createPlanReuseStore(nested);
    await store.record(record('h1'));
    expect(JSON.parse(await readFile(planReusePath(nested), 'utf-8'))).toMatchObject({ bodyHash: 'h1' });
    await store.clear();
    await expect(readFile(planReusePath(nested))).rejects.toThrow(/ENOENT/);
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('recordFrozen (#3325) records the frozen spec so the next load for the same body reuses it', async () => {
    await writeSpec(specPath, { body: '# spec', data: { route: 'codex' } });
    await createPlanReuseStore(specPath).recordFrozen('the brief');
    expect(await createPlanReuseStore(specPath).load(issueBodyHash('the brief'))).toMatchObject({ route: 'codex' });
  });

  it('recordFrozen throws and records nothing without a frozen spec or a route', async () => {
    await expect(createPlanReuseStore(specPath).recordFrozen('b')).rejects.toThrow(
      `no frozen spec with a build route at ${specPath}`,
    );
    await writeSpec(specPath, { body: '# spec', data: {} });
    await expect(createPlanReuseStore(specPath).recordFrozen('b')).rejects.toThrow(/no frozen spec/);
    await expect(readFile(planReusePath(specPath))).rejects.toThrow(/ENOENT/);
  });

  it('recordFrozen rethrows a non-ENOENT spec read error', async () => {
    await mkdir(specPath);
    await expect(createPlanReuseStore(specPath).recordFrozen('b')).rejects.toThrow(/EISDIR/);
  });
});

describe('check resume store (#2564)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'check-resume-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const entry: CheckResumeRecord = {
    issue: workKeyFromIssue(7),
    branch: 'issue-7-x',
    worktree: '/wt/7',
    diffBase: 'abc',
    route: 'claude',
    model: 'm',
    buildMinutes: 12,
    fixTarget: '.factory/constitution.md:3',
    preservedAt: '2026-01-01T00:00:00.000Z',
  };

  it('round-trips record then load, creating parent dirs', async () => {
    const store = createCheckResumeStore(join(dir, 'plans', 'issue-7.md'));
    await store.record(entry);
    expect(await store.load()).toEqual(entry);
  });

  it('load returns null for a missing file, malformed JSON and a wrong shape', async () => {
    const spec = join(dir, 'issue-7.md');
    const store = createCheckResumeStore(spec);
    expect(await store.load()).toBeNull();
    await writeFile(checkResumePath(spec), '{nope');
    expect(await store.load()).toBeNull();
    await writeFile(checkResumePath(spec), JSON.stringify({ ...entry, buildMinutes: 'x' }));
    expect(await store.load()).toBeNull();
    await writeFile(checkResumePath(spec), 'null');
    expect(await store.load()).toBeNull();
  });

  it('normalises a legacy numeric issue in the sidecar to a WorkKey', async () => {
    const spec = join(dir, 'issue-7.md');
    await writeFile(checkResumePath(spec), JSON.stringify({ ...entry, issue: 7 }));
    expect(await createCheckResumeStore(spec).load()).toEqual({ ...entry, issue: '7' });
  });

  it('clear is idempotent', async () => {
    const store = createCheckResumeStore(join(dir, 'issue-7.md'));
    await store.record(entry);
    await store.clear();
    expect(await store.load()).toBeNull();
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('maps issue-7.md to issue-7.check-resume.json', () => {
    expect(checkResumePath('/x/issue-7.md')).toBe('/x/issue-7.check-resume.json');
    expect(checkResumePath('/x/issue-7')).toBe('/x/issue-7.check-resume.json');
  });

  it('formats the preserved-build sentence', () => {
    expect(
      formatPreservedBuildMessage({ issue: workKeyFromIssue(7), branch: 'b', buildMinutes: 40, fixTarget: 'f:1' }),
    ).toBe(
      '40 min of build preserved at b; fix f:1 — if the fix lands on the default branch, run factory run-issue 7 (resume refuses once the base moves); if it was local to this machine, run factory resume 7 --from check',
    );
  });

  it('formatPreservedBuildMessage points at factory run-issue when the fix lands on main', () => {
    const msg = formatPreservedBuildMessage({
      issue: workKeyFromIssue(5),
      branch: 'b',
      buildMinutes: 3,
      fixTarget: 'f',
    });
    expect(msg).toContain('factory run-issue 5');
  });

  describe('preservedFixTarget', () => {
    const constitutionAt = (file: string, checkers: string[]): Constitution => ({
      source: 'repo',
      product: 'p',
      version: 1,
      checkers,
      body: '',
      path: file,
      repoInstance: { absPath: file, relPath: '.factory/constitution.md' },
      requireTests: true,
    });
    const configFailure = { cause: 'config' as const, failingChecks: ['unknown-checker'], logPaths: [] as string[] };

    it('points a config cause at the offending checker line', async () => {
      const file = join(dir, 'constitution.md');
      await writeFile(file, '---\nversion: 1\ncheckers:\n  - tests\n  - typecheck\n---\n');
      const target = preservedFixTarget(configFailure, constitutionAt(file, ['tests', 'typecheck']));
      expect(target).toBe('.factory/constitution.md:5');
    });

    it('falls back to the checkers: line when lint has no findings', async () => {
      const file = join(dir, 'constitution.md');
      await writeFile(file, '# C\n\ncheckers:\n  - tests\n');
      expect(preservedFixTarget(configFailure, constitutionAt(file, ['tests']))).toBe('.factory/constitution.md:3');
      await writeFile(file, '# nothing here\n');
      expect(preservedFixTarget(configFailure, constitutionAt(file, ['tests']))).toBe('.factory/constitution.md');
      expect(preservedFixTarget(configFailure, null)).toBe('the constitution checkers list');
    });

    it('uses the first existing log path for an environment cause, else the base-failing names', async () => {
      const log = join(dir, 'a.log');
      await writeFile(log, 'x');
      const env = { cause: 'environment' as const, failingChecks: ['tests', 'lint'], logPaths: [log] };
      expect(preservedFixTarget(env, null)).toBe(log);
      expect(preservedFixTarget({ ...env, logPaths: [] }, null)).toBe('the base (failing: tests, lint)');
    });

    it('preservedFixTarget skips log paths that do not exist', async () => {
      const log = join(dir, 'real.log');
      await writeFile(log, 'x');
      const missing = join(dir, 'missing.log');
      const env = { cause: 'environment' as const, failingChecks: ['tests'], logPaths: [missing, log] };
      expect(preservedFixTarget(env, null)).toBe(log);
      expect(preservedFixTarget({ ...env, logPaths: [missing] }, null)).toBe('the base (failing: tests)');
    });
  });

  describe('configParkMessage (#2583)', () => {
    const constitutionAt = (file: string, checkers: string[]): Constitution => ({
      source: 'repo',
      product: 'p',
      version: 1,
      checkers,
      body: '',
      path: file,
      repoInstance: { absPath: file, relPath: '.factory/constitution.md' },
      requireTests: true,
    });
    const failure = { cause: 'config' as const, failingChecks: ['bogus'], logPaths: [] as string[] };
    const emptySummary = { failures: 0, passes: 0, skips: 0, total: 0, results: [] };

    it('names file:line and the lint fix for an unknown checker', async () => {
      const file = join(dir, 'constitution.md');
      await writeFile(file, '---\nversion: 1\ncheckers:\n  - bogus\n---\n');
      const msg = configParkMessage({
        issue: workKeyFromIssue(7),
        failure,
        summary: emptySummary,
        constitution: constitutionAt(file, ['bogus']),
      });
      expect(msg).toContain('file: .factory/constitution.md:4');
      expect(msg.split('.factory/constitution.md:4')).toHaveLength(2);
      expect(msg).toContain("unknown checker 'bogus'");
      expect(msg).toContain('Remove the line or use one of');
      expect(msg).toContain('factory unpark 7');
    });

    it('uses the checkers: line and schema-error details when lint has no finding', async () => {
      const file = join(dir, 'constitution.md');
      await writeFile(file, '# C\n\ncheckers:\n  - tests\n');
      const msg = configParkMessage({
        issue: workKeyFromIssue(7),
        failure,
        summary: { ...emptySummary, results: [schemaErrorCheckerOutput('checkers[0]', 'entry 0 is a number')] },
        constitution: constitutionAt(file, ['tests']),
      });
      expect(msg).toContain('file: .factory/constitution.md:3');
      expect(msg).toContain('expected a list of checker names');
    });

    it('falls back to a generic target and fix with no constitution', () => {
      const msg = configParkMessage({ issue: workKeyFromIssue(7), failure, summary: emptySummary, constitution: null });
      expect(msg).toContain('file: the constitution checkers list');
      expect(msg).toContain('fix: fix the constitution checkers list so every entry is a known checker name');
    });
  });
});

describe('checkResumeBaseDrift (#3852)', () => {
  const temps = createTempDirs();
  afterEach(() => temps.cleanup());

  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
  const commit = (cwd: string, file: string): string => {
    execFileSync('sh', ['-c', `echo ${file} > ${file}`], { cwd });
    git(cwd, 'add', file);
    git(cwd, 'commit', '-q', '-m', file);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const identify = (cwd: string): void => {
    git(cwd, 'config', 'user.email', 't@example.com');
    git(cwd, 'config', 'user.name', 'T');
  };

  async function setup() {
    const root = await temps.make('drift-');
    const origin = join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    const repo = join(root, 'repo');
    git(root, 'clone', '-q', origin, repo);
    identify(repo);
    git(repo, 'checkout', '-q', '-B', 'main');
    const a = commit(repo, 'a.txt');
    git(repo, 'push', '-q', 'origin', 'main');
    const kept = join(root, 'kept');
    git(repo, 'worktree', 'add', '-q', '-b', 'factory/1-x', kept, 'main');
    identify(kept);
    commit(kept, 'work.txt');
    const advance = (): string => {
      const other = join(root, `other-${Math.random().toString(36).slice(2)}`);
      git(root, 'clone', '-q', origin, other);
      identify(other);
      const b = commit(other, 'b.txt');
      git(other, 'push', '-q', 'origin', 'main');
      return b;
    };
    return { repo, kept, a, advance };
  }

  it('checkResumeBaseDrift reports moved from A to B when origin/main advanced past the kept branch base (real git)', async () => {
    const { repo, kept, a, advance } = await setup();
    const b = advance();
    const drift = await checkResumeBaseDrift({ repoRoot: repo, record: { worktree: kept, baseSha: a } });
    expect(drift).toEqual({ kind: 'moved', from: a, to: b, ref: 'origin/main' });
    if (drift.kind === 'current') throw new Error('unexpected');
    const msg = formatBaseMovedRefusal({ issue: workKeyFromIssue(1), drift });
    expect(msg).toContain(a);
    expect(msg).toContain(b);
    expect(msg).toContain('factory run-issue 1');
  });

  it('checkResumeBaseDrift reports current when the kept branch already contains origin/main (real git)', async () => {
    const { repo, kept, a, advance } = await setup();
    const same = await checkResumeBaseDrift({ repoRoot: repo, record: { worktree: kept, baseSha: a } });
    expect(same).toEqual({ kind: 'current', ref: 'origin/main', sha: a });
    const b = advance();
    git(kept, 'fetch', '-q', 'origin');
    git(kept, 'merge', '-q', '--no-edit', 'origin/main');
    const merged = await checkResumeBaseDrift({ repoRoot: repo, record: { worktree: kept, baseSha: a } });
    expect(merged).toEqual({ kind: 'current', ref: 'origin/main', sha: b });
  });

  it('checkResumeBaseDrift falls back to diffBase when the record has no baseSha (real git)', async () => {
    const { repo, kept, a, advance } = await setup();
    advance();
    const drift = await checkResumeBaseDrift({ repoRoot: repo, record: { worktree: kept, diffBase: a } });
    expect(drift).toMatchObject({ kind: 'moved', from: a });
    const bare = await checkResumeBaseDrift({ repoRoot: repo, record: { worktree: kept } });
    expect(bare).toMatchObject({ kind: 'moved', from: a });
  });

  it('checkResumeBaseDrift reports unknown when the fetch fails', async () => {
    const { repo, kept } = await setup();
    const drift = await checkResumeBaseDrift({
      repoRoot: repo,
      record: { worktree: kept },
      fetch: () => Promise.reject(new Error('offline')),
    });
    expect(drift).toEqual({ kind: 'unknown', reason: 'git fetch origin failed: offline' });
    expect(
      formatBaseMovedRefusal({ issue: workKeyFromIssue(1), drift: drift as { kind: 'unknown'; reason: string } }),
    ).toContain('factory run-issue 1');
  });
});
