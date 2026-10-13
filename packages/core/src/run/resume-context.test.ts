import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeSpec } from '../spec/index.js';
import {
  checkResumePath,
  createCheckResumeStore,
  createPlanReuseStore,
  formatPreservedBuildMessage,
  issueBodyHash,
  planReusePath,
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
    issue: 7,
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
    expect(formatPreservedBuildMessage({ issue: 7, branch: 'b', buildMinutes: 40, fixTarget: 'f:1' })).toBe(
      '40 min of build preserved at b; fix f:1 then run factory resume 7 --from check',
    );
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

    it('uses the first log path for an environment cause, else the base-failing names', () => {
      const env = { cause: 'environment' as const, failingChecks: ['tests', 'lint'], logPaths: ['/logs/a.log'] };
      expect(preservedFixTarget(env, null)).toBe('/logs/a.log');
      expect(preservedFixTarget({ ...env, logPaths: [] }, null)).toBe('the base (failing: tests, lint)');
    });
  });
});
