import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeSpec } from '../spec/index.js';
import { createPlanReuseStore, issueBodyHash, planReusePath, type PlanReuseRecord } from './resume-context.js';

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
