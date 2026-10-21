// packages/cli/src/cli/land-risk.test.ts — risk tier gate on the autonomous merge path (#3381)
import type { Octokit } from '@octokit/rest';
import type { TrustTier } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { enforceRiskAtLand, listPullRequestPaths, type RiskGateInput } from './land-risk.js';

const ISSUE = 12;
const PR = 34;
const ALLOWED = new Set(['risk:med', 'risk:high', 'needs-human']);

function fake(files: Array<{ filename: string; previous_filename?: string }> | Error) {
  const listFiles = vi.fn(async () => {
    if (files instanceof Error) throw files;
    return { data: files };
  });
  const addLabels = vi.fn(async (_args: unknown) => ({ data: [] }));
  const createComment = vi.fn(async (_args: unknown) => ({ data: {} }));
  const octokit: Octokit = { rest: { pulls: { listFiles }, issues: { addLabels, createComment } } } as never;
  return { octokit, listFiles, addLabels, createComment };
}

function gateInput(f: ReturnType<typeof fake>, trustTier: TrustTier, labels: string[] = []) {
  const log = vi.fn();
  const input: RiskGateInput = {
    octokit: f.octokit,
    owner: 'o',
    repoName: 'r',
    issue: ISSUE,
    prNumber: PR,
    labels,
    trustTier,
    log,
  };
  return { input, log };
}

const files = (...names: string[]) => names.map((filename) => ({ filename }));

describe('enforceRiskAtLand', () => {
  it('low risk merges with no labels or comment on T0, T1 and T2', async () => {
    for (const tier of ['T0', 'T1', 'T2'] as const) {
      const f = fake(files('docs/a.md'));
      const { input } = gateInput(f, tier);
      expect(await enforceRiskAtLand(input)).toMatchObject({ merge: true });
      expect(f.addLabels).not.toHaveBeenCalled();
      expect(f.createComment).not.toHaveBeenCalled();
    }
  });

  it('med risk merges on T2 without needs-human and otherwise holds with risk:med', async () => {
    const t2 = fake(files('packages/core/src/foo.ts'));
    expect((await enforceRiskAtLand(gateInput(t2, 'T2').input)).merge).toBe(true);
    expect(t2.addLabels).not.toHaveBeenCalled();

    const t0 = fake(files('packages/core/src/foo.ts'));
    expect((await enforceRiskAtLand(gateInput(t0, 'T0').input)).merge).toBe(false);
    expect(t0.addLabels).toHaveBeenCalledWith({ owner: 'o', repo: 'r', issue_number: PR, labels: ['risk:med'] });
    expect(t0.createComment).not.toHaveBeenCalled();

    const nh = fake(files('packages/core/src/foo.ts'));
    expect((await enforceRiskAtLand(gateInput(nh, 'T2', ['needs-human']).input)).merge).toBe(false);
    expect(nh.addLabels).toHaveBeenCalledWith({ owner: 'o', repo: 'r', issue_number: PR, labels: ['risk:med'] });
  });

  it('high risk holds, labels the PR risk:high and needs-human, and comments on the issue once', async () => {
    const f = fake(files('db/migrations/001.sql'));
    const first = await enforceRiskAtLand(gateInput(f, 'T2').input);
    expect(first.merge).toBe(false);
    expect(f.addLabels).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      issue_number: PR,
      labels: ['risk:high', 'needs-human'],
    });
    expect(f.createComment).toHaveBeenCalledTimes(1);
    const sent = f.createComment.mock.calls[0]![0] as { issue_number: number; body: string };
    const body = sent.body;
    expect(sent.issue_number).toBe(ISSUE);
    expect(body).toContain('migrations-schema');
    expect(body).toContain('db/migrations/001.sql');

    f.addLabels.mockClear();
    f.createComment.mockClear();
    await enforceRiskAtLand(gateInput(f, 'T2', ['risk:high']).input);
    expect(f.createComment).not.toHaveBeenCalled();
    expect(f.addLabels).toHaveBeenCalledWith({ owner: 'o', repo: 'r', issue_number: PR, labels: ['needs-human'] });
  });

  it('never adds a factory queue label for any tier', async () => {
    const cases = [['docs/a.md'], ['packages/core/src/foo.ts'], ['db/migrations/001.sql']];
    for (const names of cases) {
      for (const tier of ['T0', 'T1', 'T2'] as const) {
        const f = fake(files(...names));
        await enforceRiskAtLand(gateInput(f, tier).input);
        for (const call of f.addLabels.mock.calls) {
          for (const label of (call[0] as { labels: string[] }).labels) {
            expect(ALLOWED.has(label)).toBe(true);
            expect(label.startsWith('factory:')).toBe(false);
          }
        }
      }
    }
  });

  it('fails closed when the PR files cannot be read', async () => {
    const f = fake(new Error('boom'));
    const { input, log } = gateInput(f, 'T2');
    const out = await enforceRiskAtLand(input);
    expect(out.merge).toBe(false);
    expect(f.addLabels).not.toHaveBeenCalled();
    expect(f.createComment).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('merge-gated', expect.stringContaining('boom'));
  });

  it('label and comment failures still hold', async () => {
    const f = fake(files('db/migrations/001.sql'));
    f.addLabels.mockRejectedValue(new Error('label denied'));
    f.createComment.mockRejectedValue(new Error('comment denied'));
    const { input, log } = gateInput(f, 'T2');
    expect((await enforceRiskAtLand(input)).merge).toBe(false);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('label denied'));
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('comment denied'));
  });
});

describe('listPullRequestPaths', () => {
  it('pages past 100 files and includes previous_filename', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `a/${i}.ts` }));
    const page2 = [{ filename: 'new.ts', previous_filename: 'old.ts' }];
    const listFiles = vi.fn(async ({ page }: { page: number }) => ({ data: page === 1 ? page1 : page2 }));
    const octokit: Octokit = { rest: { pulls: { listFiles } } } as never;
    const paths = await listPullRequestPaths(octokit, 'o', 'r', PR);
    expect(listFiles).toHaveBeenCalledTimes(2);
    expect(paths).toHaveLength(102);
    expect(paths).toContain('old.ts');
    expect(paths).toContain('new.ts');
  });
});
