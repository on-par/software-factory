// packages/scbench-adapter/src/cli-compare-report.test.ts — the compare subcommand prints the report-only per-group block (#1207).
import { describe, expect, it, vi } from 'vitest';

import type { BaselineTrial } from './baseline.js';
import { defaultCliDeps, main } from './cli-run.js';
import { minimalManifest } from './manifest-fixture.js';

function passingTrial(id: string): BaselineTrial {
  return {
    id,
    manifestPath: `/runs/${id}/manifest.json`,
    manifest: minimalManifest(),
    evidence: {
      runInfoPresent: false,
      evaluation: {
        problem_name: 'cfgpipe',
        checkpoint_name: 'checkpoint_1',
        pass_counts: { Core: 3 },
        total_counts: { Core: 3 },
        pytest_exit_code: 0,
        infrastructure_failure: false,
      },
    },
  };
}

describe('compare subcommand', () => {
  it('prints the report-only per-group block', async () => {
    const deps = {
      ...defaultCliDeps(),
      collectBaselineTrials: vi.fn((): BaselineTrial[] => [passingTrial('cfgpipe/checkpoint_1/trial-1')]),
      log: vi.fn(),
      logError: vi.fn(),
    };

    const code = await main(['compare', '--baseline', '/base', '--candidate', '/cand'], deps);

    expect(code).toBe(0);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('(report-only'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('All groups:'));
  });
});
