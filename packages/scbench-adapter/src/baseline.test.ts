import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectBaselineTrials,
  generateBaselineReport,
  loadBaselineConfig,
  type BaselineConfig,
  type BaselineFsDeps,
  type BaselineTrial,
} from './baseline.js';
import { AdapterError, type ScbenchCheckpoint } from './checkpoint.js';
import { minimalManifest } from './manifest-fixture.js';
import { runCheckpoint } from './run-checkpoint.js';
import { createExecaExec, type ExecFn } from './workspace.js';

const BASELINE_CONFIG_PATH = fileURLToPath(
  new URL('../../../evals/scbench-baseline/baseline.config.json', import.meta.url),
);
const REPORT_PATH = fileURLToPath(new URL('../../../evals/scbench-baseline/report.md', import.meta.url));
const PIN_PATH = fileURLToPath(new URL('../scbench.pin.json', import.meta.url));
// Relative to the repo root (vitest runs from there — see AGENTS.md), matching
// the --runs value the CLI was invoked with to produce the committed report.md.
// The recorded trial ids/manifestPaths must match exactly for the drift test below.
const RUNS_DIR = 'evals/scbench-baseline/runs';

const VALID_CONFIG = {
  baselineId: 'test-baseline',
  factory: { repo: 'https://example.com/repo', commit: 'a'.repeat(40), packageVersion: '2.0.0' },
  scbench: { repo: 'https://example.com/scbench', commit: 'b'.repeat(40), pinnedAt: '2026-07-28' },
  modelConfig: { source: 'models.json', env: { FACTORY_LOCAL_ONLY: 'unset' } },
  promptInputs: 'briefs from materializeBrief',
  environment: { node: '>=20', requiredBinaries: ['git'], hostClass: 'test', scbenchHarness: 'python' },
  problems: { selection: 'deterministic', smoke: 'first', suite: 'first three' },
  trials: { smokeRuns: 2, suiteTrialsPerProblem: 3 },
  comparisonThreshold: 10,
};

describe('loadBaselineConfig', () => {
  it('accepts the committed baseline config', () => {
    const raw = readFileSync(BASELINE_CONFIG_PATH, 'utf-8');
    const config = loadBaselineConfig(raw);
    expect(config.baselineId).toBe('scbench-baseline-2026-07');
    expect(config.comparisonThreshold).toBe(10);
  });

  it('accepts a well-formed synthetic config', () => {
    expect(loadBaselineConfig(JSON.stringify(VALID_CONFIG))).toEqual(VALID_CONFIG);
  });

  it('rejects unparsable JSON', () => {
    expect(() => loadBaselineConfig('{not json')).toThrow(AdapterError);
  });

  it('rejects a non-object JSON value', () => {
    expect(() => loadBaselineConfig('42')).toThrow(/must be a JSON object/);
    expect(() => loadBaselineConfig('[1,2,3]')).toThrow(/must be a JSON object/);
  });

  it('rejects a config missing a required top-level key', () => {
    const { trials: _trials, ...missingTrials } = VALID_CONFIG;
    expect(() => loadBaselineConfig(JSON.stringify(missingTrials))).toThrow(/missing required field "trials"/);
  });

  it('rejects a non-positive comparisonThreshold', () => {
    expect(() => loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, comparisonThreshold: 0 }))).toThrow(
      /comparisonThreshold.*positive/,
    );
    expect(() => loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, comparisonThreshold: '10' }))).toThrow(
      /comparisonThreshold.*positive/,
    );
  });

  it('rejects a malformed factory.commit', () => {
    expect(() =>
      loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, factory: { ...VALID_CONFIG.factory, commit: 'short' } })),
    ).toThrow(/factory\.commit/);
  });

  it('rejects a malformed scbench.commit', () => {
    expect(() =>
      loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, scbench: { ...VALID_CONFIG.scbench, commit: 'nope' } })),
    ).toThrow(/scbench\.commit/);
  });
});

describe('baseline.config.json pin-drift guard', () => {
  it('matches the committed scbench.pin.json exactly and pins a full-length factory commit SHA', () => {
    const config = loadBaselineConfig(readFileSync(BASELINE_CONFIG_PATH, 'utf-8'));
    const pin = JSON.parse(readFileSync(PIN_PATH, 'utf-8'));

    expect(config.scbench).toEqual(pin);
    expect(config.factory.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

function fakeEntry(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir } as Dirent;
}

describe('collectBaselineTrials', () => {
  it('recursively finds manifests, sorts by id, and returns [] for an empty dir', () => {
    const manifestA = JSON.stringify(minimalManifest({ run: { ...minimalManifest().run, outcome: 'failed' } }));
    const manifestB = JSON.stringify(minimalManifest());
    const tree: Record<string, ReturnType<typeof fakeEntry>[]> = {
      '/runs': [fakeEntry('z-problem', true), fakeEntry('a-problem', true), fakeEntry('notes.txt', false)],
      '/runs/z-problem': [fakeEntry('manifest.json', false)],
      '/runs/a-problem': [fakeEntry('nested', true)],
      '/runs/a-problem/nested': [fakeEntry('manifest.json', false)],
    };
    const files: Record<string, string> = {
      '/runs/z-problem/manifest.json': manifestA,
      '/runs/a-problem/nested/manifest.json': manifestB,
    };
    const deps: BaselineFsDeps = {
      readdirSync: (dir) => tree[dir] ?? [],
      readFileSync: (path) => {
        if (!(path in files)) throw new Error(`ENOENT: ${path}`);
        return files[path];
      },
    };

    const trials = collectBaselineTrials('/runs', deps);

    expect(trials.map((t) => t.id)).toEqual(['a-problem/nested', 'z-problem']);
    expect(trials[0].manifest.run.outcome).toBe('ready');
    expect(trials[1].manifest.run.outcome).toBe('failed');
  });

  it('returns [] for an empty directory', () => {
    const deps: BaselineFsDeps = { readdirSync: () => [], readFileSync: () => '' };
    expect(collectBaselineTrials('/empty', deps)).toEqual([]);
  });

  it('rejects a manifest with the wrong manifestVersion', () => {
    const deps: BaselineFsDeps = {
      readdirSync: (dir) => (dir === '/runs' ? [fakeEntry('manifest.json', false)] : []),
      readFileSync: () => JSON.stringify(minimalManifest({ manifestVersion: 999 })),
    };
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(/manifest version mismatch/);
  });

  it('wraps an unparsable manifest in an AdapterError', () => {
    const deps: BaselineFsDeps = {
      readdirSync: (dir) => (dir === '/runs' ? [fakeEntry('manifest.json', false)] : []),
      readFileSync: () => '{not json',
    };
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(AdapterError);
  });

  it('collects the committed smoke evidence from the real filesystem', () => {
    const trials = collectBaselineTrials(RUNS_DIR);
    expect(trials.map((t) => t.id)).toEqual(['smoke/trial-1', 'smoke/trial-2']);
  });
});

function trialAt(id: string, overrides: Parameters<typeof minimalManifest>[0] = {}): BaselineTrial {
  return { id, manifestPath: `evals/scbench-baseline/runs/${id}/manifest.json`, manifest: minimalManifest(overrides) };
}

describe('generateBaselineReport', () => {
  const config: BaselineConfig = VALID_CONFIG;

  it('renders "no trials" fallbacks across every section for zero trials', () => {
    const report = generateBaselineReport(config, []);
    expect(report).toContain('**Trial count:** 0 (comparison threshold: 10)');
    expect(report).toContain('**Status: PRELIMINARY**');
    expect(report).toContain('no trials recorded');
    expect(report).toContain('Not yet measurable — requires the live multi-checkpoint suite run.');
    expect(report).toContain('No trials recorded.');
    expect(report).toContain('No routing or failover events recorded.');
    expect(report).toContain('No failures recorded.');
  });

  it('computes checkpoint pass rate from a ready/failed mix', () => {
    const trials = [
      trialAt('a', { run: { ...minimalManifest().run, outcome: 'ready' } }),
      trialAt('b', { run: { ...minimalManifest().run, outcome: 'failed' } }),
      trialAt('c', { run: { ...minimalManifest().run, outcome: 'ready' } }),
    ];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain('2/3 (66.7%)');
  });

  it('shows the PRELIMINARY banner (with trial count + config scope) below threshold, and omits it at/above threshold', () => {
    const below = generateBaselineReport({ ...config, comparisonThreshold: 2 }, [trialAt('a')]);
    expect(below).toContain('**Status: PRELIMINARY**');
    expect(below).toContain('only 1 of the required 2 trials');
    expect(below).toContain(config.baselineId);
    expect(below).toContain(config.factory.commit);
    expect(below).toContain(config.scbench.commit);

    const atThreshold = generateBaselineReport({ ...config, comparisonThreshold: 1 }, [trialAt('a')]);
    expect(atThreshold).not.toContain('PRELIMINARY');
    expect(atThreshold).toContain('**Status: comparison-ready**');
  });

  it('renders per-problem erosion sequences when multi-checkpoint trial ids are present', () => {
    const trials = [
      trialAt('suite/calculator/1', { run: { ...minimalManifest().run, outcome: 'ready' } }),
      trialAt('suite/calculator/2', { run: { ...minimalManifest().run, outcome: 'failed' } }),
      trialAt('suite/other/1', { run: { ...minimalManifest().run, outcome: 'ready' } }),
    ];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain('- calculator: `suite/calculator/1`: ready, `suite/calculator/2`: failed');
    expect(report).toContain('- other: `suite/other/1`: ready');
    expect(report).not.toContain('Not yet measurable');
  });

  it('states the not-yet-measurable sentence when no trial id has problem-grouping depth', () => {
    const report = generateBaselineReport(config, [trialAt('smoke/trial-1'), trialAt('smoke/trial-2')]);
    expect(report).toContain('Not yet measurable — requires the live multi-checkpoint suite run.');
  });

  it('sums elapsed time and cost across trials', () => {
    const trials = [
      trialAt('a', {
        run: { ...minimalManifest().run, elapsedMs: 1000 },
        cost: { totalUsd: 0.5, inputTokens: 100, outputTokens: 50, entries: [] },
      }),
      trialAt('b', {
        run: { ...minimalManifest().run, elapsedMs: 3000 },
        cost: { totalUsd: 1.5, inputTokens: 200, outputTokens: 150, entries: [] },
      }),
    ];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain('Total elapsed: 4000ms across 2 trial(s); mean 2000.0ms.');
    expect(report).toContain('Total cost: $2.0000; input tokens: 300; output tokens: 200.');
  });

  it('aggregates routing/failover attempts by model+task, including failover reasons', () => {
    const trials = [
      trialAt('a', {
        modelAttempts: [
          { model: 'claude', task: 'plan', attempt: '1' },
          { model: 'claude', task: 'plan', attempt: '2', reason: 'rate_limit' },
        ],
      }),
      trialAt('b', { modelAttempts: [{ model: 'codex', task: 'build', attempt: '1' }] }),
    ];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain('claude / plan: 2 attempt(s); failover reasons: rate_limit');
    expect(report).toContain('codex / build: 1 attempt(s)');
  });

  it('renders checker outcomes for trials with and without a checker summary', () => {
    const trials = [
      trialAt('a', { checker: { passes: 3, failures: 1, skips: 0, total: 4, results: [] } }),
      trialAt('b', {}),
    ];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain('`a`: 3 passed, 1 failed, 0 skipped (total 4).');
    expect(report).toContain('`b`: No checker data (run ended before CHECK or checker summary absent).');
  });

  it('renders failure notes only for trials that carry a failure', () => {
    const trials = [
      trialAt('a', { failure: { phase: 'build', reason: 'fail', message: 'tests red' } }),
      trialAt('b', {}),
    ];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain('`a`: phase `build`, reason `fail` — tests red');
    expect(report).not.toMatch(/`b`: phase/);
  });

  it('is deterministic across repeated calls with the same inputs (no wall-clock or random state)', () => {
    const trials = [trialAt('a'), trialAt('b')];
    expect(generateBaselineReport(config, trials)).toBe(generateBaselineReport(config, trials));
  });
});

describe('baseline report drift', () => {
  it('regenerates the committed report.md byte-identically from the committed config + manifests', () => {
    const config = loadBaselineConfig(readFileSync(BASELINE_CONFIG_PATH, 'utf-8'));
    const trials = collectBaselineTrials(RUNS_DIR);
    const regenerated = generateBaselineReport(config, trials);
    const committed = readFileSync(REPORT_PATH, 'utf-8');
    expect(regenerated).toBe(committed);
  });
});

function writeFactoryArtifacts(dir: string, workspace: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(minimalManifest({ run: { ...minimalManifest().run, workspace } })),
  );
  writeFileSync(join(dir, 'request.json'), '{}');
  writeFileSync(join(dir, 'events.ndjson'), '');
  writeFileSync(join(dir, 'diff.patch'), '');
}

describe('smoke checkpoint run twice (reproducibility)', () => {
  const realExec = createExecaExec();
  let workspaces: string[] = [];
  let artifactRoots: string[] = [];

  afterEach(() => {
    for (const dir of [...workspaces, ...artifactRoots]) rmSync(dir, { recursive: true, force: true });
    workspaces = [];
    artifactRoots = [];
  });

  it('produces host-independent, comparable manifests across two independent trials', async () => {
    const checkpoint: ScbenchCheckpoint = { problemId: 'smoke', checkpointId: '1', index: 0, task: 'Prove wiring.' };
    const results = [];

    for (let i = 0; i < 2; i += 1) {
      const workspace = mkdtempSync(join(tmpdir(), `scb-baseline-smoke-ws-${i}-`));
      const artifactsRoot = mkdtempSync(join(tmpdir(), `scb-baseline-smoke-art-${i}-`));
      workspaces.push(workspace);
      artifactRoots.push(artifactsRoot);

      const exec: ExecFn = async (argv, opts) => {
        const [bin, ...rest] = argv;
        if (bin === 'git') return realExec(argv, opts);
        if (bin === 'stub-factory') {
          writeFactoryArtifacts(rest[5], workspace);
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected command: ${argv.join(' ')}`);
      };

      results.push(await runCheckpoint(checkpoint, { workspace, artifactsRoot, factoryBin: 'stub-factory' }, { exec }));
    }

    expect(results.map((r) => r.outcome)).toEqual(['ready', 'ready']);

    for (let i = 0; i < 2; i += 1) {
      const dir = join(artifactRoots[i], 'smoke', '1');
      expect(existsSync(join(dir, 'brief.md'))).toBe(true);
      expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
      expect(existsSync(join(dir, 'request.json'))).toBe(true);
    }

    const normalize = (i: number) => {
      const raw = JSON.parse(readFileSync(join(artifactRoots[i], 'smoke', '1', 'manifest.json'), 'utf-8'));
      return { ...raw, run: { ...raw.run, workspace: '<workspace>' } };
    };
    expect(normalize(0)).toEqual(normalize(1));
  });
});
