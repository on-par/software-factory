import { describe, expect, it, vi } from 'vitest';

import type { BaselineTrial } from './baseline.js';
import { AdapterError, type CheckpointResult } from './checkpoint.js';
import { defaultCliDeps, main, type CliDeps } from './cli-run.js';
import { minimalManifest } from './manifest-fixture.js';
import type { CatalogPreflightOutcome } from './catalog-preflight.js';
import type { PinPreflightOutcome } from './pin-preflight.js';

const RESULT: CheckpointResult = {
  outcome: 'ready',
  workspace: '/tmp/ws',
  artifactsDir: '/tmp/artifacts/calculator/1',
  briefPath: '/tmp/artifacts/calculator/1/brief.md',
  manifestPath: '/tmp/artifacts/calculator/1/manifest.json',
};

const VALID_CONFIG_JSON = JSON.stringify({
  baselineId: 'test-baseline',
  factory: { repo: 'https://example.com/repo', commit: 'a'.repeat(40), packageVersion: '2.0.0' },
  scbench: { repo: 'https://example.com/scbench', commit: 'b'.repeat(40), pinnedAt: '2026-07-28' },
  problemCatalog: {
    repo: 'https://example.com/problems',
    version: 'v1.0',
    commit: 'c'.repeat(40),
    pinnedAt: '2026-07-29',
  },
  modelConfig: { source: 'models.json', env: {} },
  promptInputs: 'briefs',
  environment: { node: '>=20', requiredBinaries: [], hostClass: 'test', scbenchHarness: 'python' },
  problems: { resolvedFrom: 'resolved from the catalog commit', smoke: 'alpha', suite: ['alpha', 'beta', 'gamma'] },
  trials: { smokeRuns: 2, suiteTrialsPerProblem: 3 },
  comparisonThreshold: 10,
  passPolicy: { id: 'core-cases', description: 'Core-group tests must all pass.' },
});

const VALID_PIN_JSON = JSON.stringify({
  repo: 'https://example.com/scbench',
  commit: 'a'.repeat(40),
  pinnedAt: '2026-07-28',
  problems: { repo: 'https://example.com/problems', version: 'v1.0', commit: 'b'.repeat(40), pinnedAt: '2026-07-29' },
});

const ALL_OK_OUTCOME: PinPreflightOutcome = {
  ok: true,
  results: [
    { input: 'SCBENCH_CHECKOUT', ok: true, detail: `HEAD matches pinned commit ${'a'.repeat(40)}, working tree clean` },
    {
      input: 'SCBENCH_PROBLEMS_PATH',
      ok: true,
      detail: `HEAD matches pinned commit ${'b'.repeat(40)}, working tree clean`,
    },
  ],
};

const ALL_OK_CATALOG_OUTCOME: CatalogPreflightOutcome = {
  ok: true,
  results: [
    { subject: 'adapter build', ok: true, detail: 'build output present: /pkg/dist/cli.js' },
    { subject: 'SCBENCH_PROBLEMS_PATH', ok: true, detail: 'catalog checkout present: /tmp/problems' },
    { subject: 'problem alpha', ok: true, detail: 'resolves in catalog (alpha/config.yaml)' },
    { subject: 'problem beta', ok: true, detail: 'resolves in catalog (beta/config.yaml)' },
    { subject: 'problem gamma', ok: true, detail: 'resolves in catalog (gamma/config.yaml)' },
  ],
  confirmedProblemIds: ['alpha', 'beta', 'gamma'],
};

function fakeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    readTaskFile: vi.fn(async () => 'do the thing'),
    runCheckpoint: vi.fn(async () => RESULT),
    readBaselineConfig: vi.fn(async () => VALID_CONFIG_JSON),
    collectBaselineTrials: vi.fn((): BaselineTrial[] => []),
    writeReport: vi.fn(async () => undefined),
    log: vi.fn(),
    logError: vi.fn(),
    readPinFile: vi.fn(async () => VALID_PIN_JSON),
    env: { SCBENCH_CHECKOUT: '/tmp/checkout', SCBENCH_PROBLEMS_PATH: '/tmp/problems' },
    runPinPreflight: vi.fn(async () => ALL_OK_OUTCOME),
    runCatalogPreflight: vi.fn(() => ALL_OK_CATALOG_OUTCOME),
    ...overrides,
  };
}

describe('cli-run main', () => {
  it('prints usage and exits 2 for an unknown/missing subcommand', async () => {
    const deps = fakeDeps();

    const code = await main([], deps);

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('usage:'));
  });

  it('exits 2 when required flags are missing', async () => {
    const deps = fakeDeps();

    const code = await main(['run-checkpoint', '--workspace', '/tmp/ws'], deps);

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('missing required flag'));
  });

  it('ignores stray non-flag tokens and a flag immediately followed by another flag', async () => {
    const deps = fakeDeps();

    const code = await main(
      [
        'run-checkpoint',
        'stray-positional',
        '--index',
        '--workspace',
        '/tmp/ws',
        '--artifacts',
        '/tmp/artifacts',
        '--task-file',
        '/tmp/task.md',
        '--problem',
        'calculator',
        '--checkpoint',
        '1',
      ],
      deps,
    );

    expect(code).toBe(0);
    expect(deps.runCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }), {
      workspace: '/tmp/ws',
      artifactsRoot: '/tmp/artifacts',
      factoryBin: undefined,
    });
  });

  it('ignores a dangling flag with no trailing value at the end of argv', async () => {
    const deps = fakeDeps();

    const code = await main(
      [
        'run-checkpoint',
        '--workspace',
        '/tmp/ws',
        '--artifacts',
        '/tmp/artifacts',
        '--task-file',
        '/tmp/task.md',
        '--problem',
        'calculator',
        '--checkpoint',
        '1',
        '--factory-bin',
      ],
      deps,
    );

    expect(code).toBe(0);
    expect(deps.runCheckpoint).toHaveBeenCalledWith(expect.anything(), {
      workspace: '/tmp/ws',
      artifactsRoot: '/tmp/artifacts',
      factoryBin: undefined,
    });
  });

  it('parses flags, reads the task file, and prints the CheckpointResult as JSON on success', async () => {
    const deps = fakeDeps();

    const code = await main(
      [
        'run-checkpoint',
        '--workspace',
        '/tmp/ws',
        '--artifacts',
        '/tmp/artifacts',
        '--task-file',
        '/tmp/task.md',
        '--problem',
        'calculator',
        '--checkpoint',
        '1',
        '--index',
        '0',
        '--factory-bin',
        '/opt/factory',
      ],
      deps,
    );

    expect(code).toBe(0);
    expect(deps.readTaskFile).toHaveBeenCalledWith('/tmp/task.md');
    expect(deps.runCheckpoint).toHaveBeenCalledWith(
      { problemId: 'calculator', checkpointId: '1', index: 0, task: 'do the thing' },
      { workspace: '/tmp/ws', artifactsRoot: '/tmp/artifacts', factoryBin: '/opt/factory' },
    );
    expect(deps.log).toHaveBeenCalledWith(JSON.stringify(RESULT));
  });

  it('defaults --index to 0 when omitted', async () => {
    const deps = fakeDeps();

    await main(
      [
        'run-checkpoint',
        '--workspace',
        '/tmp/ws',
        '--artifacts',
        '/tmp/artifacts',
        '--task-file',
        '/tmp/task.md',
        '--problem',
        'calculator',
        '--checkpoint',
        '1',
      ],
      deps,
    );

    expect(deps.runCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }), expect.anything());
  });

  it('exits 2 when the task file cannot be read', async () => {
    const deps = fakeDeps({ readTaskFile: vi.fn(async () => Promise.reject(new Error('ENOENT'))) });

    const code = await main(
      [
        'run-checkpoint',
        '--workspace',
        '/tmp/ws',
        '--artifacts',
        '/tmp/artifacts',
        '--task-file',
        '/tmp/missing.md',
        '--problem',
        'calculator',
        '--checkpoint',
        '1',
      ],
      deps,
    );

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
  });

  it('exits 2 when runCheckpoint throws an AdapterError', async () => {
    const deps = fakeDeps({
      runCheckpoint: vi.fn(async () => {
        throw new AdapterError('workspace unwritable');
      }),
    });

    const code = await main(
      [
        'run-checkpoint',
        '--workspace',
        '/tmp/ws',
        '--artifacts',
        '/tmp/artifacts',
        '--task-file',
        '/tmp/task.md',
        '--problem',
        'calculator',
        '--checkpoint',
        '1',
      ],
      deps,
    );

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith('workspace unwritable');
  });

  it('re-throws unexpected (non-AdapterError) errors', async () => {
    const deps = fakeDeps({
      runCheckpoint: vi.fn(async () => {
        throw new Error('boom');
      }),
    });

    await expect(
      main(
        [
          'run-checkpoint',
          '--workspace',
          '/tmp/ws',
          '--artifacts',
          '/tmp/artifacts',
          '--task-file',
          '/tmp/task.md',
          '--problem',
          'calculator',
          '--checkpoint',
          '1',
        ],
        deps,
      ),
    ).rejects.toThrow('boom');
  });
});

describe('baseline-report subcommand', () => {
  it('prints usage and exits 2 when called with no subcommand at all', async () => {
    const deps = fakeDeps();
    const code = await main(['baseline-report'], deps);
    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('missing required flag'));
  });

  it('exits 2 when required flags are missing', async () => {
    const deps = fakeDeps();
    const code = await main(['baseline-report', '--config', '/tmp/cfg.json'], deps);
    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('missing required flag(s): --runs, --out'));
  });

  it('reads the config, collects trials, writes the report, and exits 0 on success', async () => {
    const deps = fakeDeps();

    const code = await main(
      ['baseline-report', '--config', '/tmp/cfg.json', '--runs', '/tmp/runs', '--out', '/tmp/out.md'],
      deps,
    );

    expect(code).toBe(0);
    expect(deps.readBaselineConfig).toHaveBeenCalledWith('/tmp/cfg.json');
    expect(deps.collectBaselineTrials).toHaveBeenCalledWith('/tmp/runs');
    expect(deps.writeReport).toHaveBeenCalledWith('/tmp/out.md', expect.stringContaining('test-baseline'));
    expect(deps.log).toHaveBeenCalledWith('wrote baseline report to /tmp/out.md');
  });

  it('renders trials returned by collectBaselineTrials into the written report', async () => {
    const trial: BaselineTrial = {
      id: 'smoke/trial-1',
      manifestPath: '/tmp/runs/smoke/trial-1/manifest.json',
      manifest: minimalManifest(),
      evidence: { runInfoPresent: false },
    };
    const deps = fakeDeps({ collectBaselineTrials: vi.fn(() => [trial]) });

    await main(['baseline-report', '--config', '/tmp/cfg.json', '--runs', '/tmp/runs', '--out', '/tmp/out.md'], deps);

    expect(deps.writeReport).toHaveBeenCalledWith('/tmp/out.md', expect.stringContaining('smoke/trial-1'));
  });

  it('exits 2 when --config cannot be read', async () => {
    const deps = fakeDeps({
      readBaselineConfig: vi.fn(async () => Promise.reject(new Error('ENOENT'))),
    });

    const code = await main(
      ['baseline-report', '--config', '/tmp/missing.json', '--runs', '/tmp/runs', '--out', '/tmp/out.md'],
      deps,
    );

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
  });

  it('exits 2 when the config is structurally invalid', async () => {
    const deps = fakeDeps({ readBaselineConfig: vi.fn(async () => '{"not":"valid"}') });

    const code = await main(
      ['baseline-report', '--config', '/tmp/cfg.json', '--runs', '/tmp/runs', '--out', '/tmp/out.md'],
      deps,
    );

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('missing required field'));
  });

  it('exits 2 when collectBaselineTrials throws an AdapterError (invalid manifest under --runs)', async () => {
    const deps = fakeDeps({
      collectBaselineTrials: vi.fn(() => {
        throw new AdapterError('manifest version mismatch');
      }),
    });

    const code = await main(
      ['baseline-report', '--config', '/tmp/cfg.json', '--runs', '/tmp/runs', '--out', '/tmp/out.md'],
      deps,
    );

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith('manifest version mismatch');
  });

  it('re-throws unexpected (non-AdapterError) errors from collectBaselineTrials', async () => {
    const deps = fakeDeps({
      collectBaselineTrials: vi.fn(() => {
        throw new Error('boom');
      }),
    });

    await expect(
      main(['baseline-report', '--config', '/tmp/cfg.json', '--runs', '/tmp/runs', '--out', '/tmp/out.md'], deps),
    ).rejects.toThrow('boom');
  });
});

describe('pin-preflight subcommand', () => {
  it('exits 0 and logs an ok line per input when the preflight passes', async () => {
    const deps = fakeDeps();

    const code = await main(['pin-preflight'], deps);

    expect(code).toBe(0);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('SCBENCH_CHECKOUT ok'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('SCBENCH_PROBLEMS_PATH ok'));
  });

  it('exits 1 and logs a FAIL line naming the failing input on a commit mismatch', async () => {
    const outcome: PinPreflightOutcome = {
      ok: false,
      results: [
        ALL_OK_OUTCOME.results[0],
        {
          input: 'SCBENCH_PROBLEMS_PATH',
          ok: false,
          detail: `HEAD ${'c'.repeat(40)} does not match pinned commit ${'b'.repeat(40)}`,
        },
      ],
    };
    const deps = fakeDeps({ runPinPreflight: vi.fn(async () => outcome) });

    const code = await main(['pin-preflight'], deps);

    expect(code).toBe(1);
    expect(deps.logError).toHaveBeenCalledWith(
      expect.stringContaining('SCBENCH_PROBLEMS_PATH FAIL — HEAD ' + 'c'.repeat(40)),
    );
  });

  it('exits 2 with a "could not read pin file" message when readPinFile rejects', async () => {
    const deps = fakeDeps({ readPinFile: vi.fn(async () => Promise.reject(new Error('ENOENT'))) });

    const code = await main(['pin-preflight'], deps);

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('could not read pin file'));
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
  });

  it('exits 2 when the pin file content is malformed', async () => {
    const deps = fakeDeps({ readPinFile: vi.fn(async () => '{"not":"valid"}') });

    const code = await main(['pin-preflight'], deps);

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('missing required field'));
  });

  it('wires env values and the pinned commits from the pin file into the specs passed to runPinPreflight', async () => {
    const deps = fakeDeps({
      env: { SCBENCH_CHECKOUT: '/opt/checkout', SCBENCH_PROBLEMS_PATH: '/opt/problems' },
    });

    await main(['pin-preflight'], deps);

    expect(deps.runPinPreflight).toHaveBeenCalledWith([
      { input: 'SCBENCH_CHECKOUT', path: '/opt/checkout', expectedCommit: 'a'.repeat(40) },
      { input: 'SCBENCH_PROBLEMS_PATH', path: '/opt/problems', expectedCommit: 'b'.repeat(40) },
    ]);
  });

  it('passes --pin through to readPinFile', async () => {
    const deps = fakeDeps();

    await main(['pin-preflight', '--pin', '/custom/scbench.pin.json'], deps);

    expect(deps.readPinFile).toHaveBeenCalledWith('/custom/scbench.pin.json');
  });

  it('re-throws unexpected (non-AdapterError) errors from runPinPreflight', async () => {
    const deps = fakeDeps({
      runPinPreflight: vi.fn(async () => {
        throw new Error('boom');
      }),
    });

    await expect(main(['pin-preflight'], deps)).rejects.toThrow('boom');
  });
});

describe('catalog-preflight subcommand', () => {
  it('exits 0, logs an ok line per result, and logs the confirmed problem ids on a passing outcome', async () => {
    const deps = fakeDeps();

    const code = await main(['catalog-preflight'], deps);

    expect(code).toBe(0);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('adapter build ok'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('SCBENCH_PROBLEMS_PATH ok'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('problem alpha ok'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('confirmed problem ids — alpha, beta, gamma'));
  });

  it('passes the deduped smoke+suite ids and SCBENCH_PROBLEMS_PATH to runCatalogPreflight', async () => {
    const deps = fakeDeps({ env: { SCBENCH_PROBLEMS_PATH: '/opt/problems' } });

    await main(['catalog-preflight'], deps);

    expect(deps.runCatalogPreflight).toHaveBeenCalledWith({
      adapterCli: expect.stringContaining('cli.js'),
      catalogPath: '/opt/problems',
      problemIds: ['alpha', 'beta', 'gamma'],
    });
  });

  it('exits 1 and logs a FAIL line naming the missing build artifact, without a confirmed-ids line', async () => {
    const outcome: CatalogPreflightOutcome = {
      ok: false,
      results: [
        {
          subject: 'adapter build',
          ok: false,
          detail: 'missing build output /pkg/dist/cli.js — run `npm run build` first',
        },
        ...ALL_OK_CATALOG_OUTCOME.results.slice(1),
      ],
      confirmedProblemIds: [],
    };
    const deps = fakeDeps({ runCatalogPreflight: vi.fn(() => outcome) });

    const code = await main(['catalog-preflight'], deps);

    expect(code).toBe(1);
    expect(deps.logError).toHaveBeenCalledWith(
      expect.stringContaining('adapter build FAIL — missing build output /pkg/dist/cli.js'),
    );
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('confirmed problem ids'));
  });

  it('exits 1 and logs a FAIL line naming an unknown problem id', async () => {
    const outcome: CatalogPreflightOutcome = {
      ok: false,
      results: [
        ...ALL_OK_CATALOG_OUTCOME.results.slice(0, 2),
        {
          subject: 'problem not_a_real_problem',
          ok: false,
          detail:
            'unknown problem id not_a_real_problem — no config.yaml at /tmp/problems/not_a_real_problem/config.yaml',
        },
      ],
      confirmedProblemIds: [],
    };
    const deps = fakeDeps({ runCatalogPreflight: vi.fn(() => outcome) });

    const code = await main(['catalog-preflight'], deps);

    expect(code).toBe(1);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('problem not_a_real_problem FAIL'));
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('unknown problem id not_a_real_problem'));
  });

  it('exits 2 with a "could not read --config" message when readBaselineConfig rejects', async () => {
    const deps = fakeDeps({ readBaselineConfig: vi.fn(async () => Promise.reject(new Error('ENOENT'))) });

    const code = await main(['catalog-preflight'], deps);

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('could not read --config'));
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
  });

  it('exits 2 when the baseline config content is invalid', async () => {
    const deps = fakeDeps({ readBaselineConfig: vi.fn(async () => '{"not":"valid"}') });

    const code = await main(['catalog-preflight'], deps);

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('missing required field'));
  });

  it('passes --config through to readBaselineConfig', async () => {
    const deps = fakeDeps();

    await main(['catalog-preflight', '--config', '/custom/baseline.config.json'], deps);

    expect(deps.readBaselineConfig).toHaveBeenCalledWith('/custom/baseline.config.json');
  });

  it('re-throws unexpected (non-AdapterError) errors from runCatalogPreflight', async () => {
    const deps = fakeDeps({
      runCatalogPreflight: vi.fn(() => {
        throw new Error('boom');
      }),
    });

    await expect(main(['catalog-preflight'], deps)).rejects.toThrow('boom');
  });
});

describe('launch', () => {
  const LAUNCHER_SMOKE =
    'uv run --project "/tmp/checkout" python packages/scbench-adapter/python/run_scbench.py run --config packages/scbench-adapter/scbench.run.yaml --problem alpha';
  const LAUNCHER_BETA =
    'uv run --project "/tmp/checkout" python packages/scbench-adapter/python/run_scbench.py run --config packages/scbench-adapter/scbench.run.yaml --problem beta';
  const LAUNCHER_GAMMA =
    'uv run --project "/tmp/checkout" python packages/scbench-adapter/python/run_scbench.py run --config packages/scbench-adapter/scbench.run.yaml --problem gamma';

  it('prints the launcher command + confirmed problem ids and exits 0 without invoking anything', async () => {
    const deps = fakeDeps();

    const code = await main(['launch'], deps);

    expect(code).toBe(0);
    expect(deps.log).toHaveBeenCalledWith('scbench: confirmed problem ids — alpha, beta, gamma');
    expect(deps.log).toHaveBeenCalledWith(LAUNCHER_SMOKE);
    expect(deps.log).toHaveBeenCalledWith(LAUNCHER_BETA);
    expect(deps.log).toHaveBeenCalledWith(LAUNCHER_GAMMA);
    expect(deps.runCheckpoint).not.toHaveBeenCalled();
  });

  it('tolerates a bare --dry-run flag, behaving exactly as a plain launch', async () => {
    const deps = fakeDeps();

    const code = await main(['launch', '--dry-run'], deps);

    expect(code).toBe(0);
    expect(deps.log).toHaveBeenCalledWith('scbench: confirmed problem ids — alpha, beta, gamma');
    expect(deps.log).toHaveBeenCalledWith(LAUNCHER_SMOKE);
    expect(deps.runCheckpoint).not.toHaveBeenCalled();
  });

  it('gates the launcher on a pin-preflight failure, printing no uv run line', async () => {
    const outcome: PinPreflightOutcome = {
      ok: false,
      results: [
        ALL_OK_OUTCOME.results[0],
        {
          input: 'SCBENCH_PROBLEMS_PATH',
          ok: false,
          detail: `HEAD ${'c'.repeat(40)} does not match pinned commit ${'b'.repeat(40)}`,
        },
      ],
    };
    const deps = fakeDeps({ runPinPreflight: vi.fn(async () => outcome) });

    const code = await main(['launch'], deps);

    expect(code).toBe(1);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('pin-preflight: SCBENCH_PROBLEMS_PATH FAIL'));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('uv run'));
    expect(deps.logError).not.toHaveBeenCalledWith(expect.stringContaining('uv run'));
  });

  it('gates the launcher on a catalog-preflight failure, printing no uv run line', async () => {
    const outcome: CatalogPreflightOutcome = {
      ok: false,
      results: [
        {
          subject: 'adapter build',
          ok: false,
          detail: 'missing build output /pkg/dist/cli.js — run `npm run build` first',
        },
        ...ALL_OK_CATALOG_OUTCOME.results.slice(1),
      ],
      confirmedProblemIds: [],
    };
    const deps = fakeDeps({ runCatalogPreflight: vi.fn(() => outcome) });

    const code = await main(['launch'], deps);

    expect(code).toBe(1);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('catalog-preflight: adapter build FAIL'));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('uv run'));
  });

  it('exits 2 with a "could not read pin file" message when readPinFile rejects', async () => {
    const deps = fakeDeps({ readPinFile: vi.fn(async () => Promise.reject(new Error('ENOENT'))) });

    const code = await main(['launch'], deps);

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('could not read pin file'));
  });

  it('exits 2 with a "could not read --config" message when readBaselineConfig rejects', async () => {
    const deps = fakeDeps({ readBaselineConfig: vi.fn(async () => Promise.reject(new Error('ENOENT'))) });

    const code = await main(['launch'], deps);

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('could not read --config'));
  });

  it('reports both failing preflights in one run — no short-circuit', async () => {
    const pinOutcome: PinPreflightOutcome = {
      ok: false,
      results: [{ input: 'SCBENCH_CHECKOUT', ok: false, detail: 'is not set' }, ALL_OK_OUTCOME.results[1]],
    };
    const catalogOutcome: CatalogPreflightOutcome = {
      ok: false,
      results: [
        {
          subject: 'adapter build',
          ok: false,
          detail: 'missing build output /pkg/dist/cli.js — run `npm run build` first',
        },
        ...ALL_OK_CATALOG_OUTCOME.results.slice(1),
      ],
      confirmedProblemIds: [],
    };
    const deps = fakeDeps({
      runPinPreflight: vi.fn(async () => pinOutcome),
      runCatalogPreflight: vi.fn(() => catalogOutcome),
    });

    const code = await main(['launch'], deps);

    expect(code).toBe(1);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('pin-preflight: SCBENCH_CHECKOUT FAIL'));
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('catalog-preflight: adapter build FAIL'));
  });
});

describe('pin-preflight and catalog-preflight subcommands stay byte-identical after the launch refactor', () => {
  it('pin-preflight still exits 0 with the same ok lines', async () => {
    const deps = fakeDeps();
    const code = await main(['pin-preflight'], deps);
    expect(code).toBe(0);
    expect(deps.log).toHaveBeenCalledWith(
      'pin-preflight: SCBENCH_CHECKOUT ok — HEAD matches pinned commit ' + 'a'.repeat(40) + ', working tree clean',
    );
  });

  it('catalog-preflight still exits 0 with the same confirmed-ids line', async () => {
    const deps = fakeDeps();
    const code = await main(['catalog-preflight'], deps);
    expect(code).toBe(0);
    expect(deps.log).toHaveBeenCalledWith('catalog-preflight: confirmed problem ids — alpha, beta, gamma');
  });
});

describe('defaultCliDeps', () => {
  it('logs to console.log/console.error and reads real files', async () => {
    const deps = defaultCliDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    deps.log('hello');
    deps.logError('oops');
    expect(logSpy).toHaveBeenCalledWith('hello');
    expect(errorSpy).toHaveBeenCalledWith('oops');

    await expect(deps.readTaskFile('/definitely/does/not/exist.md')).rejects.toThrow();

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('reads a real baseline config and writes a real report file', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const deps = defaultCliDeps();
    const dir = mkdtempSync(join(tmpdir(), 'scb-cli-baseline-'));
    try {
      const configPath = join(dir, 'cfg.json');
      const outPath = join(dir, 'out.md');
      const raw = JSON.stringify({
        baselineId: 'x',
        factory: { repo: 'r', commit: 'a'.repeat(40), packageVersion: '1.0.0' },
        scbench: { repo: 'r', commit: 'b'.repeat(40), pinnedAt: '2026-07-28' },
        problemCatalog: { repo: 'r', version: 'v1.0', commit: 'c'.repeat(40), pinnedAt: '2026-07-29' },
        modelConfig: { source: 's', env: {} },
        promptInputs: 'p',
        environment: { node: '>=20', requiredBinaries: [], hostClass: 'h', scbenchHarness: 'p' },
        problems: { resolvedFrom: 's', smoke: 's', suite: ['s'] },
        trials: { smokeRuns: 1, suiteTrialsPerProblem: 1 },
        comparisonThreshold: 10,
      });
      await deps.writeReport(configPath, raw);
      expect(await deps.readBaselineConfig(configPath)).toBe(raw);
      await deps.writeReport(outPath, 'report content');
      expect(readFileSync(outPath, 'utf-8')).toBe('report content');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes process.env and reads a real pin file', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const deps = defaultCliDeps();
    expect(deps.env).toBe(process.env);

    const dir = mkdtempSync(join(tmpdir(), 'scb-cli-pin-'));
    try {
      const pinPath = join(dir, 'scbench.pin.json');
      writeFileSync(pinPath, VALID_PIN_JSON);
      expect(await deps.readPinFile(pinPath)).toBe(VALID_PIN_JSON);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs a real pin preflight against a non-git directory (fails closed, no crash)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const deps = defaultCliDeps();
    const dir = mkdtempSync(join(tmpdir(), 'scb-cli-pin-run-'));
    try {
      const outcome = await deps.runPinPreflight([{ input: 'X', path: dir, expectedCommit: 'a'.repeat(40) }]);
      expect(outcome.ok).toBe(false);
      expect(outcome.results[0].detail).toContain('not a git checkout');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs a real catalog preflight against a missing adapter bin and unset catalog path (fails closed, no crash)', () => {
    const deps = defaultCliDeps();

    const outcome = deps.runCatalogPreflight({
      adapterCli: '/definitely/does/not/exist/cli.js',
      catalogPath: undefined,
      problemIds: ['alpha'],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.results.find((r) => r.subject === 'adapter build')?.ok).toBe(false);
    expect(outcome.results.find((r) => r.subject === 'SCBENCH_PROBLEMS_PATH')?.detail).toBe('is not set');
  });
});
