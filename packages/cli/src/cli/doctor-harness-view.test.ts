import { describe, expect, it } from 'vitest';

import { commandHarnessChecks } from './doctor.js';
import { resolveDoctorHarnesses } from './doctor-harness-view.js';

describe('resolveDoctorHarnesses (#2870)', () => {
  const agent = { command: 'my-agent --headless', prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none' };
  const loaders = (repo: unknown) => ({
    loadModelsConfig: () => ({ models: {}, tiers: {}, harnesses: {} }) as never,
    loadRepoConfig: () => {
      if (repo instanceof Error) throw repo;
      return repo as never;
    },
  });

  it('merges a repo-declared harness and lists its id', () => {
    const view = resolveDoctorHarnesses(loaders({ version: 2, harnesses: { 'my-agent': agent } }), '/r');
    expect(view.merged).toHaveProperty('my-agent');
    expect(view.declaredIds).toContain('my-agent');
    expect(view.mergeError).toBeUndefined();
  });

  it('reports a redeclared built-in harness as a merge error and keeps the declared ids', () => {
    const view = resolveDoctorHarnesses(loaders({ version: 2, harnesses: { 'claude-cli': agent } }), '/r');
    expect(view.merged).toBeUndefined();
    expect(view.mergeError).toContain('claude-cli');
    expect(view.declaredIds).toEqual(['claude-cli']);
  });

  it('returns no ids and no merge error when the repo config fails to load', () => {
    expect(resolveDoctorHarnesses(loaders(new Error('bad yaml')), '/r')).toEqual({ declaredIds: [] });
  });

  it('keeps the packaged harnesses when there is no repo config', () => {
    expect(resolveDoctorHarnesses(loaders(null), '/r').merged).toEqual({});
  });

  it('names harnesses.<id>.command in .factory/config.yaml in the install fix', () => {
    const [row] = commandHarnessChecks(
      [{ harness: 'my-agent', command: 'my-agent', executable: 'my-agent' }],
      () => false,
    );
    expect(row!.fix).toContain('harnesses.my-agent.command in .factory/config.yaml');
  });
});
