import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectBaselineTrials,
  evaluateTrialVerdict,
  generateBaselineReport,
  loadBaselineConfig,
  GITHUB_WRITE_EVENT_KINDS,
  type BaselineConfig,
  type BaselineFsDeps,
  type BaselineTrial,
  type BaselineTrialEvidence,
  type ScbenchEvaluation,
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
  problemCatalog: {
    repo: 'https://example.com/problems',
    version: 'v1.0',
    commit: 'c'.repeat(40),
    pinnedAt: '2026-07-29',
  },
  modelConfig: { source: 'packages/config/src/defaults.ts at factory.commit', env: { FACTORY_LOCAL_ONLY: 'unset' } },
  providerPolicy: {
    approvedModels: ['claude-fable-5', 'claude-sonnet-5'],
    disabledProviders: ['ollama'],
    providers: { ollama: false as const },
  },
  promptInputs: 'briefs from materializeBrief',
  environment: { node: '>=20', requiredBinaries: ['git'], hostClass: 'test', scbenchHarness: 'python' },
  problems: { resolvedFrom: 'resolved from the catalog commit', smoke: 'alpha', suite: ['alpha', 'beta', 'gamma'] },
  trials: { smokeRuns: 2, suiteTrialsPerProblem: 3 },
  comparisonThreshold: 10,
  passPolicy: { id: 'core-cases' as const, description: 'Core-group tests must all pass.' },
};

function minimalEvaluation(overrides: Partial<ScbenchEvaluation> = {}): ScbenchEvaluation {
  return {
    problem_name: 'calculator',
    checkpoint_name: 'checkpoint_1',
    pass_counts: { Core: 3, Functionality: 2 },
    total_counts: { Core: 3, Functionality: 2 },
    pytest_exit_code: 0,
    infrastructure_failure: false,
    ...overrides,
  };
}

/** evaluation.json is untrusted input read off disk; these overrides are typed as `unknown` per
 *  field precisely so the validation-failure cases can express values the schema must reject. */
function malformedEvaluationJson(overrides: { [K in keyof ScbenchEvaluation]?: unknown }): string {
  return JSON.stringify({ ...minimalEvaluation(), ...overrides });
}

describe('loadBaselineConfig', () => {
  it('accepts the committed baseline config', () => {
    const raw = readFileSync(BASELINE_CONFIG_PATH, 'utf-8');
    const config = loadBaselineConfig(raw);
    expect(config.baselineId).toBe('scbench-baseline-2026-07');
    expect(config.comparisonThreshold).toBe(10);
    expect(config.passPolicy).toEqual({
      id: 'core-cases',
      description: expect.stringContaining('PassPolicy.CORE_CASES'),
    });
    expect(config.problemCatalog.commit).toBe('4d38d300059667d57e43c31969bc455f5c338b52');
    expect(config.problems.smoke).toBe('cfgpipe');
    expect(config.problems.suite).toEqual(['cfgpipe', 'circuit_eval', 'code_search']);
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

  it('rejects a config missing passPolicy', () => {
    const { passPolicy: _passPolicy, ...missingPassPolicy } = VALID_CONFIG;
    expect(() => loadBaselineConfig(JSON.stringify(missingPassPolicy))).toThrow(/missing required field "passPolicy"/);
  });

  it('rejects a passPolicy.id other than "core-cases"', () => {
    expect(() =>
      loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, passPolicy: { id: 'all-cases', description: 'x' } })),
    ).toThrow(/passPolicy\.id/);
  });

  it('rejects a missing or empty passPolicy.description', () => {
    expect(() =>
      loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, passPolicy: { id: 'core-cases', description: '' } })),
    ).toThrow(/passPolicy\.description/);
    expect(() => loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, passPolicy: { id: 'core-cases' } }))).toThrow(
      /passPolicy\.description/,
    );
  });

  it('rejects a malformed problemCatalog.commit', () => {
    expect(() =>
      loadBaselineConfig(
        JSON.stringify({ ...VALID_CONFIG, problemCatalog: { ...VALID_CONFIG.problemCatalog, commit: 'short' } }),
      ),
    ).toThrow(/problemCatalog\.commit/);
  });

  it('rejects an empty problemCatalog.version', () => {
    expect(() =>
      loadBaselineConfig(
        JSON.stringify({ ...VALID_CONFIG, problemCatalog: { ...VALID_CONFIG.problemCatalog, version: '' } }),
      ),
    ).toThrow(/problemCatalog\.version/);
  });

  it('rejects problems.smoke as a prose selection rule instead of an exact id', () => {
    expect(() =>
      loadBaselineConfig(
        JSON.stringify({
          ...VALID_CONFIG,
          problems: { ...VALID_CONFIG.problems, smoke: 'the lexicographically first problem id' },
        }),
      ),
    ).toThrow(/problems\.smoke/);
  });

  it('rejects problems.suite as a string instead of an array', () => {
    expect(() =>
      loadBaselineConfig(
        JSON.stringify({ ...VALID_CONFIG, problems: { ...VALID_CONFIG.problems, suite: 'first three' } }),
      ),
    ).toThrow(/problems\.suite/);
  });

  it('rejects an empty problems.suite array', () => {
    expect(() =>
      loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, problems: { ...VALID_CONFIG.problems, suite: [] } })),
    ).toThrow(/problems\.suite/);
  });

  it('rejects duplicate ids in problems.suite', () => {
    expect(() =>
      loadBaselineConfig(
        JSON.stringify({ ...VALID_CONFIG, problems: { ...VALID_CONFIG.problems, suite: ['alpha', 'alpha'] } }),
      ),
    ).toThrow(/problems\.suite/);
  });

  it('rejects an empty problems.resolvedFrom', () => {
    expect(() =>
      loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, problems: { ...VALID_CONFIG.problems, resolvedFrom: '' } })),
    ).toThrow(/problems\.resolvedFrom/);
  });

  it('rejects the six-wrong-fields regression from the issue, naming the first offender', () => {
    const bad = {
      ...VALID_CONFIG,
      baselineId: 42,
      promptInputs: ['a'],
      modelConfig: 'not-an-object',
      environment: { node: '>=20' },
      trials: { smokeRuns: 'three', suiteTrialsPerProblem: 3 },
    };
    expect(() => loadBaselineConfig(JSON.stringify(bad))).toThrow(AdapterError);
    expect(() => loadBaselineConfig(JSON.stringify(bad))).toThrow(/baselineId/);
  });

  it('rejects a non-numeric trials.smokeRuns', () => {
    expect(() =>
      loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, trials: { ...VALID_CONFIG.trials, smokeRuns: 'three' } })),
    ).toThrow(/trials\.smokeRuns/);
  });

  it('rejects a zero or fractional trials.suiteTrialsPerProblem', () => {
    expect(() =>
      loadBaselineConfig(
        JSON.stringify({ ...VALID_CONFIG, trials: { ...VALID_CONFIG.trials, suiteTrialsPerProblem: 0 } }),
      ),
    ).toThrow(/trials\.suiteTrialsPerProblem/);
    expect(() =>
      loadBaselineConfig(
        JSON.stringify({ ...VALID_CONFIG, trials: { ...VALID_CONFIG.trials, suiteTrialsPerProblem: 1.5 } }),
      ),
    ).toThrow(/trials\.suiteTrialsPerProblem/);
  });

  it('rejects a non-string baselineId', () => {
    expect(() => loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, baselineId: 42 }))).toThrow(/baselineId/);
  });

  it('rejects a non-string promptInputs', () => {
    expect(() => loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, promptInputs: ['a'] }))).toThrow(/promptInputs/);
  });

  it('rejects a modelConfig that is not an object', () => {
    expect(() => loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, modelConfig: 'not-an-object' }))).toThrow(
      /modelConfig/,
    );
  });

  it('rejects a modelConfig.env with a non-string value', () => {
    expect(() =>
      loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, modelConfig: { source: 's', env: { A: 1 } } })),
    ).toThrow(/modelConfig\.env/);
  });

  it('rejects a modelConfig.source referencing the deleted models.json or routes.json', () => {
    expect(() =>
      loadBaselineConfig(
        JSON.stringify({
          ...VALID_CONFIG,
          modelConfig: { ...VALID_CONFIG.modelConfig, source: 'packages/config/src/models.json' },
        }),
      ),
    ).toThrow(/modelConfig\.source/);
    expect(() =>
      loadBaselineConfig(
        JSON.stringify({
          ...VALID_CONFIG,
          modelConfig: { ...VALID_CONFIG.modelConfig, source: 'packages/config/src/routes.json' },
        }),
      ),
    ).toThrow(/modelConfig\.source/);
  });

  it('rejects a config missing providerPolicy', () => {
    const { providerPolicy: _providerPolicy, ...missingProviderPolicy } = VALID_CONFIG;
    expect(() => loadBaselineConfig(JSON.stringify(missingProviderPolicy))).toThrow(
      /missing required field "providerPolicy"/,
    );
  });

  it('rejects an empty or duplicate providerPolicy.approvedModels', () => {
    expect(() =>
      loadBaselineConfig(
        JSON.stringify({
          ...VALID_CONFIG,
          providerPolicy: { ...VALID_CONFIG.providerPolicy, approvedModels: [] },
        }),
      ),
    ).toThrow(/providerPolicy\.approvedModels/);
    expect(() =>
      loadBaselineConfig(
        JSON.stringify({
          ...VALID_CONFIG,
          providerPolicy: { ...VALID_CONFIG.providerPolicy, approvedModels: ['a', 'a'] },
        }),
      ),
    ).toThrow(/providerPolicy\.approvedModels/);
  });

  it('rejects an empty providerPolicy.disabledProviders', () => {
    expect(() =>
      loadBaselineConfig(
        JSON.stringify({
          ...VALID_CONFIG,
          providerPolicy: { ...VALID_CONFIG.providerPolicy, disabledProviders: [] },
        }),
      ),
    ).toThrow(/providerPolicy\.disabledProviders/);
  });

  it('rejects a config missing providerPolicy.providers', () => {
    const { providers: _providers, ...restProviderPolicy } = VALID_CONFIG.providerPolicy;
    expect(() => loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, providerPolicy: restProviderPolicy }))).toThrow(
      /providerPolicy\.providers/,
    );
  });

  it('rejects providerPolicy.providers.ollama when it is not literally false', () => {
    expect(() =>
      loadBaselineConfig(
        JSON.stringify({
          ...VALID_CONFIG,
          providerPolicy: { ...VALID_CONFIG.providerPolicy, providers: { ollama: true } },
        }),
      ),
    ).toThrow(/providerPolicy\.providers\.ollama/);
  });

  it('rejects an environment missing its sub-fields', () => {
    expect(() => loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, environment: { node: '>=20' } }))).toThrow(
      /environment\.requiredBinaries/,
    );
  });

  it('rejects a non-array environment.requiredBinaries', () => {
    expect(() =>
      loadBaselineConfig(
        JSON.stringify({
          ...VALID_CONFIG,
          environment: { ...VALID_CONFIG.environment, requiredBinaries: 'git' },
        }),
      ),
    ).toThrow(/environment\.requiredBinaries/);
  });

  it('rejects a non-string factory.packageVersion', () => {
    expect(() =>
      loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, factory: { ...VALID_CONFIG.factory, packageVersion: 2 } })),
    ).toThrow(/factory\.packageVersion/);
  });

  it('strips unknown top-level keys instead of rejecting them', () => {
    const config = loadBaselineConfig(JSON.stringify({ ...VALID_CONFIG, extra: 'ignored' }));
    expect(config).toEqual(VALID_CONFIG);
    expect(config).not.toHaveProperty('extra');
  });
});

describe('baseline.config.json pin-drift guard', () => {
  it('matches the committed scbench.pin.json exactly and pins a full-length factory commit SHA', () => {
    const config = loadBaselineConfig(readFileSync(BASELINE_CONFIG_PATH, 'utf-8'));
    const { problems: pinProblems, ...pinScbench } = JSON.parse(readFileSync(PIN_PATH, 'utf-8'));

    // Whole-object equality (minus the nested `problems` block, mirrored separately
    // below) so any future top-level field added to scbench.pin.json must also be
    // mirrored into baseline.config.json's `scbench` block or this test fails.
    expect(config.scbench).toEqual(pinScbench);
    expect(config.problemCatalog).toEqual(pinProblems);
    expect(config.factory.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

const FIXTURE_CONFIG_PATH = fileURLToPath(
  new URL('./__fixtures__/collect-trial/baseline.config.json', import.meta.url),
);
const FIXTURE_EXPECTED_REPORT_PATH = fileURLToPath(
  new URL('./__fixtures__/collect-trial/expected-report.md', import.meta.url),
);

describe('baseline provenance never references the deleted models.json/routes.json', () => {
  it.each([
    ['committed baseline.config.json', BASELINE_CONFIG_PATH],
    ['committed report.md', REPORT_PATH],
    ['fixture baseline.config.json', FIXTURE_CONFIG_PATH],
    ['fixture expected-report.md', FIXTURE_EXPECTED_REPORT_PATH],
  ])('%s does not mention models.json or routes.json', (_label, path) => {
    const raw = readFileSync(path, 'utf-8');
    expect(raw).not.toMatch(/models\.json|routes\.json/);
  });

  it('the committed baseline.config.json names packages/config/src/defaults.ts as the model/route source', () => {
    const config = loadBaselineConfig(readFileSync(BASELINE_CONFIG_PATH, 'utf-8'));
    expect(config.modelConfig.source).toContain('packages/config/src/defaults.ts');
  });
});

function fakeEntry(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir } as Dirent;
}

/** Fake fs deps for collectBaselineTrials tests: `paths` is the exhaustive
 *  set of paths that exist (runsDir, manifest.json files, and any evidence
 *  files under test) — any other existsSync check answers false, so a trial
 *  dir with no evidence entries never attempts to read one. */
function fakeDeps(
  tree: Record<string, ReturnType<typeof fakeEntry>[]>,
  files: Record<string, string>,
  extraExists: string[] = [],
): BaselineFsDeps {
  const exists = new Set([...Object.keys(tree), ...Object.keys(files), ...extraExists]);
  return {
    existsSync: (path) => exists.has(path),
    readdirSync: (dir) => tree[dir] ?? [],
    readFileSync: (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
  };
}

describe('collectBaselineTrials', () => {
  it('recursively finds manifests, sorts by id, and returns [] for an empty dir', () => {
    const manifestA = JSON.stringify(minimalManifest({ run: { ...minimalManifest().run, outcome: 'failed' } }));
    const manifestB = JSON.stringify(minimalManifest());
    const manifestC = JSON.stringify(minimalManifest());
    const tree: Record<string, ReturnType<typeof fakeEntry>[]> = {
      '/runs': [
        fakeEntry('z-problem', true),
        fakeEntry('m-problem', true),
        fakeEntry('a-problem', true),
        fakeEntry('notes.txt', false),
      ],
      '/runs/z-problem': [fakeEntry('manifest.json', false)],
      '/runs/m-problem': [fakeEntry('manifest.json', false)],
      '/runs/a-problem': [fakeEntry('nested', true)],
      '/runs/a-problem/nested': [fakeEntry('manifest.json', false)],
    };
    const files: Record<string, string> = {
      '/runs/z-problem/manifest.json': manifestA,
      '/runs/m-problem/manifest.json': manifestC,
      '/runs/a-problem/nested/manifest.json': manifestB,
    };
    const deps = fakeDeps(tree, files, ['/runs']);

    const trials = collectBaselineTrials('/runs', deps);

    expect(trials.map((t) => t.id)).toEqual(['a-problem/nested', 'm-problem', 'z-problem']);
    expect(trials[0].manifest.run.outcome).toBe('ready');
    expect(trials[2].manifest.run.outcome).toBe('failed');
    expect(trials[0].evidence).toEqual({ runInfoPresent: false });
    expect(trials[2].evidence).toEqual({ runInfoPresent: false });
  });

  it('returns [] for an empty directory', () => {
    const deps: BaselineFsDeps = { existsSync: () => true, readdirSync: () => [], readFileSync: () => '' };
    expect(collectBaselineTrials('/empty', deps)).toEqual([]);
  });

  it('rejects a missing --runs directory with an AdapterError instead of a raw ENOENT', () => {
    const deps: BaselineFsDeps = {
      existsSync: () => false,
      readdirSync: () => {
        throw new Error('ENOENT: should never be reached');
      },
      readFileSync: () => '',
    };
    expect(() => collectBaselineTrials('/does/not/exist', deps)).toThrow(AdapterError);
    expect(() => collectBaselineTrials('/does/not/exist', deps)).toThrow(/no such directory/);
  });

  it('rejects a manifest with the wrong manifestVersion', () => {
    const deps = fakeDeps(
      { '/runs': [fakeEntry('manifest.json', false)] },
      { '/runs/manifest.json': JSON.stringify(minimalManifest({ manifestVersion: 999 })) },
      ['/runs'],
    );
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(/manifest version mismatch/);
  });

  it('wraps an unparsable manifest in an AdapterError', () => {
    const deps = fakeDeps({ '/runs': [fakeEntry('manifest.json', false)] }, { '/runs/manifest.json': '{not json' }, [
      '/runs',
    ]);
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(AdapterError);
  });

  it('loads all three native evidence files when present', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/evaluation.json': JSON.stringify(minimalEvaluation()),
      '/runs/checkpoint_results.jsonl': `${JSON.stringify({
        problem: 'calculator',
        checkpoint: 'checkpoint_1',
        state: 'passed',
        core_passed: 3,
        core_total: 3,
      })}\n\n`,
    };
    const deps = fakeDeps(tree, files, ['/runs', '/runs/run_info.yaml']);

    const [trial] = collectBaselineTrials('/runs', deps);

    expect(trial.evidence.evaluation).toEqual(minimalEvaluation());
    expect(trial.evidence.runRecords).toEqual([
      { problem: 'calculator', checkpoint: 'checkpoint_1', state: 'passed', core_passed: 3, core_total: 3 },
    ]);
    expect(trial.evidence.runInfoPresent).toBe(true);
  });

  it('parses events.ndjson into factoryEvents, ignoring blank lines and lines without a string type', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/events.ndjson': '{"type":"local-only-complete"}\n\n{"event":"no type field"}\n{"type":"build"}\n',
    };
    const deps = fakeDeps(tree, files, ['/runs']);

    const [trial] = collectBaselineTrials('/runs', deps);

    expect(trial.evidence.factoryEvents).toEqual({ githubWriteKinds: [], localOnlyComplete: true });
  });

  it('collects sorted unique GitHub-write kinds from events.ndjson', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/events.ndjson': '{"type":"landed"}\n{"type":"ship"}\n{"type":"landed"}\n',
    };
    const deps = fakeDeps(tree, files, ['/runs']);

    const [trial] = collectBaselineTrials('/runs', deps);

    expect(trial.evidence.factoryEvents).toEqual({ githubWriteKinds: ['landed', 'ship'], localOnlyComplete: false });
  });

  it('leaves factoryEvents undefined when a events.ndjson line is unparsable', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/events.ndjson': 'not json at all',
    };
    const deps = fakeDeps(tree, files, ['/runs']);

    const [trial] = collectBaselineTrials('/runs', deps);

    expect(trial.evidence.factoryEvents).toBeUndefined();
  });

  it('leaves factoryEvents undefined when events.ndjson is absent', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = { '/runs/manifest.json': JSON.stringify(minimalManifest()) };
    const deps = fakeDeps(tree, files, ['/runs']);

    const [trial] = collectBaselineTrials('/runs', deps);

    expect(trial.evidence.factoryEvents).toBeUndefined();
  });

  it('yields empty-but-defined factoryEvents for an empty events.ndjson', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = { '/runs/manifest.json': JSON.stringify(minimalManifest()), '/runs/events.ndjson': '' };
    const deps = fakeDeps(tree, files, ['/runs']);

    const [trial] = collectBaselineTrials('/runs', deps);

    expect(trial.evidence.factoryEvents).toEqual({ githubWriteKinds: [], localOnlyComplete: false });
  });

  it('records no evidence when none of the three files are present', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = { '/runs/manifest.json': JSON.stringify(minimalManifest()) };
    const deps = fakeDeps(tree, files, ['/runs']);

    const [trial] = collectBaselineTrials('/runs', deps);

    expect(trial.evidence).toEqual({ runInfoPresent: false });
  });

  it('wraps an unparsable evaluation.json in an AdapterError naming the path', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/evaluation.json': '{not json',
    };
    const deps = fakeDeps(tree, files, ['/runs']);
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(AdapterError);
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(/evaluation\.json/);
  });

  it('rejects a valid-JSON evaluation.json that is not an object', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/evaluation.json': '[1,2,3]',
    };
    const deps = fakeDeps(tree, files, ['/runs']);
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(/evaluation evidence at .*must be a JSON object/);
  });

  it('rejects evaluation.json with a missing/empty problem_name', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/evaluation.json': JSON.stringify(minimalEvaluation({ problem_name: '' })),
    };
    const deps = fakeDeps(tree, files, ['/runs']);
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(/field "problem_name" must be a non-empty string/);
  });

  it('rejects evaluation.json with a missing/empty checkpoint_name', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/evaluation.json': JSON.stringify(minimalEvaluation({ checkpoint_name: '' })),
    };
    const deps = fakeDeps(tree, files, ['/runs']);
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(/field "checkpoint_name" must be a non-empty string/);
  });

  it('rejects evaluation.json with a non-boolean infrastructure_failure', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/evaluation.json': malformedEvaluationJson({ infrastructure_failure: 'no' }),
    };
    const deps = fakeDeps(tree, files, ['/runs']);
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(/field "infrastructure_failure" must be a boolean/);
  });

  it('rejects evaluation.json with a non-numeric pass_counts value', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/evaluation.json': malformedEvaluationJson({ pass_counts: { Core: 'three' } }),
    };
    const deps = fakeDeps(tree, files, ['/runs']);
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(/field "pass_counts" must be/);
  });

  it('rejects evaluation.json with a non-numeric total_counts value', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/evaluation.json': malformedEvaluationJson({ total_counts: { Core: 'three' } }),
    };
    const deps = fakeDeps(tree, files, ['/runs']);
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(/field "total_counts" must be/);
  });

  it('rejects evaluation.json with a non-numeric pytest_exit_code', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/evaluation.json': malformedEvaluationJson({ pytest_exit_code: 'zero' }),
    };
    const deps = fakeDeps(tree, files, ['/runs']);
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(/field "pytest_exit_code" must be a number/);
  });

  it('wraps an unparsable checkpoint_results.jsonl line in an AdapterError naming path and line number', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/checkpoint_results.jsonl': 'not json at all',
    };
    const deps = fakeDeps(tree, files, ['/runs']);
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(/checkpoint_results\.jsonl line 1/);
  });

  it('rejects a valid-JSON checkpoint_results.jsonl line that is not an object', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/checkpoint_results.jsonl': '[1,2,3]',
    };
    const deps = fakeDeps(tree, files, ['/runs']);
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(/run record at .*line 1: must be a JSON object/);
  });

  it('rejects a checkpoint_results.jsonl record missing core_total', () => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/checkpoint_results.jsonl': JSON.stringify({
        problem: 'calculator',
        checkpoint: 'checkpoint_1',
        state: 'passed',
        core_passed: 3,
      }),
    };
    const deps = fakeDeps(tree, files, ['/runs']);
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(/field "core_total" must be a number/);
  });

  const RUN_RECORD_FIELD_CASES: [string, Record<string, unknown>, RegExp][] = [
    [
      'problem',
      { checkpoint: 'checkpoint_1', state: 'passed', core_passed: 3, core_total: 3 },
      /field "problem" must be a string/,
    ],
    [
      'checkpoint',
      { problem: 'calculator', state: 'passed', core_passed: 3, core_total: 3 },
      /field "checkpoint" must be a string/,
    ],
    [
      'state',
      { problem: 'calculator', checkpoint: 'checkpoint_1', core_passed: 3, core_total: 3 },
      /field "state" must be a string/,
    ],
    [
      'core_passed',
      { problem: 'calculator', checkpoint: 'checkpoint_1', state: 'passed', core_total: 3 },
      /field "core_passed" must be a number/,
    ],
  ];

  it.each(RUN_RECORD_FIELD_CASES)('rejects a checkpoint_results.jsonl record missing %s', (_field, record, re) => {
    const tree = { '/runs': [fakeEntry('manifest.json', false)] };
    const files = {
      '/runs/manifest.json': JSON.stringify(minimalManifest()),
      '/runs/checkpoint_results.jsonl': JSON.stringify(record),
    };
    const deps = fakeDeps(tree, files, ['/runs']);
    expect(() => collectBaselineTrials('/runs', deps)).toThrow(re);
  });

  it('collects the committed smoke evidence from the real filesystem', () => {
    const trials = collectBaselineTrials(RUNS_DIR);
    expect(trials.map((t) => t.id)).toEqual(['smoke/trial-1', 'smoke/trial-2']);
    for (const trial of trials) {
      expect(trial.evidence).toEqual({
        runInfoPresent: false,
        factoryEvents: { githubWriteKinds: [], localOnlyComplete: false },
      });
    }
  });
});

function trialAt(
  id: string,
  overrides: Parameters<typeof minimalManifest>[0] = {},
  evidence: BaselineTrialEvidence = { runInfoPresent: false },
): BaselineTrial {
  return {
    id,
    manifestPath: `evals/scbench-baseline/runs/${id}/manifest.json`,
    manifest: minimalManifest(overrides),
    evidence,
  };
}

describe('evaluateTrialVerdict', () => {
  it('returns missing-evidence when there is no native evaluation', () => {
    expect(evaluateTrialVerdict(trialAt('a'))).toBe('missing-evidence');
  });

  it('returns infrastructure-failure when the evaluation reports one', () => {
    const trial = trialAt(
      'a',
      {},
      { evaluation: minimalEvaluation({ infrastructure_failure: true }), runInfoPresent: false },
    );
    expect(evaluateTrialVerdict(trial)).toBe('infrastructure-failure');
  });

  it('returns pass when Core pass_counts equals total_counts', () => {
    const trial = trialAt('a', {}, { evaluation: minimalEvaluation(), runInfoPresent: false });
    expect(evaluateTrialVerdict(trial)).toBe('pass');
  });

  it('returns fail when Core pass_counts is less than total_counts', () => {
    const trial = trialAt(
      'a',
      {},
      { evaluation: minimalEvaluation({ pass_counts: { Core: 2 }, total_counts: { Core: 3 } }), runInfoPresent: false },
    );
    expect(evaluateTrialVerdict(trial)).toBe('fail');
  });

  it('treats a missing Core key in pass_counts/total_counts as 0/0 (upstream vacuous pass)', () => {
    const trial = trialAt(
      'a',
      {},
      {
        evaluation: minimalEvaluation({ pass_counts: { Functionality: 2 }, total_counts: { Functionality: 2 } }),
        runInfoPresent: false,
      },
    );
    expect(evaluateTrialVerdict(trial)).toBe('pass');
  });
});

describe('generateBaselineReport', () => {
  const config: BaselineConfig = VALID_CONFIG;

  it('renders "no trials" fallbacks across every section for zero trials', () => {
    const report = generateBaselineReport(config, []);
    expect(report).toContain('**Trial count:** 0 (comparison threshold: 10)');
    expect(report).toContain('**Status: PRELIMINARY**');
    expect(report).toContain('no trials recorded');
    expect(report).toContain('Not yet measurable — requires native SCBench evaluation evidence');
    expect(report).toContain('No trials recorded.');
    expect(report).toContain('No routing or failover events recorded.');
    expect(report).toContain('No failures recorded.');
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
      trialAt('b', {
        modelAttempts: [
          { model: 'codex', task: 'build', attempt: '1' },
          { model: 'aardvark', task: 'setup', attempt: '1' },
        ],
      }),
    ];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain('claude / plan: 2 attempt(s); failover reasons: rate_limit');
    expect(report).toContain('codex / build: 1 attempt(s)');
    expect(report).toContain('aardvark / setup: 1 attempt(s)');
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

  it('renders native evidence presence in the Trials section', () => {
    const trials = [
      trialAt('a', {}, { evaluation: minimalEvaluation(), runRecords: [], runInfoPresent: true }),
      trialAt('b', {}, { runInfoPresent: false }),
    ];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain('`a`: outcome `ready`, elapsed 60000ms');
    expect(report).toContain('native evidence: evaluation.json, checkpoint_results.jsonl, run_info.yaml');
    expect(report).toContain('`b`: outcome `ready`, elapsed 60000ms, manifest');
    expect(report).toContain('native evidence: none');
  });

  it('a ready manifest with no native evidence cannot render as a benchmark pass', () => {
    const trials = [
      trialAt('a', { run: { ...minimalManifest().run, outcome: 'ready' } }),
      trialAt('b', { run: { ...minimalManifest().run, outcome: 'ready' } }),
    ];
    const report = generateBaselineReport(config, trials);

    expect(report).toContain(
      'Not measurable — none of the 2 recorded trial(s) carries native SCBench evaluation evidence (`evaluation.json`)',
    );
    expect(report).not.toMatch(/`a`: pass/);
    expect(report).not.toMatch(/`b`: pass/);
    expect(report).toContain('2/2 (100.0%) of Factory runs ended `ready`');
    expect(report).toContain("not that SCBench's checkpoint evaluation passed");
  });

  it('renders pass/fail/infrastructure-failure verdicts with mixed denominators', () => {
    const trials = [
      trialAt('a', {}, { evaluation: minimalEvaluation(), runInfoPresent: false }),
      trialAt(
        'b',
        {},
        {
          evaluation: minimalEvaluation({ pass_counts: { Core: 2 }, total_counts: { Core: 3 } }),
          runInfoPresent: false,
        },
      ),
      trialAt('c', {}, { evaluation: minimalEvaluation({ infrastructure_failure: true }), runInfoPresent: false }),
      trialAt('d'),
    ];
    const report = generateBaselineReport(config, trials);

    expect(report).toContain(
      '1/4 (25.0%) under pass policy `core-cases` — 1 pass, 1 fail, 1 infrastructure failure, 1 missing evidence.',
    );
    expect(report).toContain('- `a`: pass — Core 3/3 (calculator / checkpoint_1)');
    expect(report).toContain('- `b`: fail — Core 2/3 (calculator / checkpoint_1)');
    expect(report).toContain('- `c`: infrastructure failure — native evaluation reports infrastructure_failure');
    expect(report).toContain('- `d`: missing evidence — no evaluation.json in the trial directory');
  });

  it('renders "Core 0/0" when the Core key is absent from pass_counts/total_counts', () => {
    const trials = [
      trialAt(
        'a',
        {},
        {
          evaluation: minimalEvaluation({ pass_counts: { Functionality: 2 }, total_counts: { Functionality: 2 } }),
          runInfoPresent: false,
        },
      ),
    ];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain('- `a`: pass — Core 0/0 (calculator / checkpoint_1)');
  });

  it('groups erosion by evaluation.problem_name, ordering checkpoints numerically', () => {
    const trials = [
      trialAt(
        'suite/calculator/1',
        {},
        {
          evaluation: minimalEvaluation({ problem_name: 'calculator', checkpoint_name: 'checkpoint_1' }),
          runInfoPresent: false,
        },
      ),
      trialAt(
        'suite/calculator/2',
        {},
        {
          evaluation: minimalEvaluation({
            problem_name: 'calculator',
            checkpoint_name: 'checkpoint_2',
            pass_counts: { Core: 1 },
            total_counts: { Core: 3 },
          }),
          runInfoPresent: false,
        },
      ),
      trialAt(
        'suite/calculator/10',
        {},
        {
          evaluation: minimalEvaluation({ problem_name: 'calculator', checkpoint_name: 'checkpoint_10' }),
          runInfoPresent: false,
        },
      ),
      trialAt(
        'suite/other/1',
        {},
        {
          evaluation: minimalEvaluation({ problem_name: 'other', checkpoint_name: 'checkpoint_1' }),
          runInfoPresent: false,
        },
      ),
    ];
    const report = generateBaselineReport(config, trials);

    expect(report).toContain(
      '- calculator: checkpoint_1 `suite/calculator/1`: pass (Core 3/3), checkpoint_2 `suite/calculator/2`: fail (Core 1/3), checkpoint_10 `suite/calculator/10`: pass (Core 3/3)',
    );
    expect(report).toContain('- other: checkpoint_1 `suite/other/1`: pass (Core 3/3)');
    expect(report).not.toContain('Not yet measurable');
  });

  it('falls back to lexicographic checkpoint_name ordering when neither checkpoint has a trailing integer', () => {
    const trials = [
      trialAt(
        'suite/calculator/final',
        {},
        {
          evaluation: minimalEvaluation({ problem_name: 'calculator', checkpoint_name: 'checkpoint_final' }),
          runInfoPresent: false,
        },
      ),
      trialAt(
        'suite/calculator/alpha',
        {},
        {
          evaluation: minimalEvaluation({ problem_name: 'calculator', checkpoint_name: 'checkpoint_alpha' }),
          runInfoPresent: false,
        },
      ),
    ];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain(
      '- calculator: checkpoint_alpha `suite/calculator/alpha`: pass (Core 3/3), checkpoint_final `suite/calculator/final`: pass (Core 3/3)',
    );
  });

  it('tiebreaks by trial id when checkpoint_name is identical across trials in a problem', () => {
    const sameCheckpoint = (id: string) =>
      trialAt(
        id,
        {},
        {
          evaluation: minimalEvaluation({
            problem_name: 'dup',
            checkpoint_name: 'checkpoint_shared',
            pass_counts: { Functionality: 1 },
            total_counts: { Functionality: 1 },
          }),
          runInfoPresent: false,
        },
      );
    const trials = [sameCheckpoint('suite/dup/c'), sameCheckpoint('suite/dup/a'), sameCheckpoint('suite/dup/b')];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain(
      '- dup: checkpoint_shared `suite/dup/a`: pass (Core 0/0), checkpoint_shared `suite/dup/b`: pass (Core 0/0), checkpoint_shared `suite/dup/c`: pass (Core 0/0)',
    );
  });

  it('states the not-yet-measurable erosion sentence when no trial carries native evaluation evidence', () => {
    const report = generateBaselineReport(config, [trialAt('smoke/trial-1'), trialAt('smoke/trial-2')]);
    expect(report).toContain(
      'Not yet measurable — requires native SCBench evaluation evidence from the live multi-checkpoint suite run.',
    );
  });

  it('renders "confirmed" when every trial has attempts and all observed models are approved', () => {
    const trials = [
      trialAt('a', { modelAttempts: [{ model: 'claude-fable-5', task: 'plan', attempt: '1' }] }),
      trialAt('b', { modelAttempts: [{ model: 'claude-sonnet-5', task: 'build', attempt: '1' }] }),
    ];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain(
      'Declared policy (source: packages/config/src/defaults.ts at factory.commit): approved models `claude-fable-5`, `claude-sonnet-5`; disabled providers: `ollama`',
    );
    expect(report).toContain('- `a`: observed models `claude-fable-5` — all approved');
    expect(report).toContain(
      'Ollama disabled: confirmed — every trial recorded at least one model attempt and every observed model is in the approved set; no disabled-provider model was observed.',
    );
  });

  it('renders NOT CONFIRMED when a trial observes a model outside the approved set', () => {
    const trials = [trialAt('a', { modelAttempts: [{ model: 'qwen2.5-coder:14b', task: 'build', attempt: '1' }] })];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain(
      '- `a`: observed models `qwen2.5-coder:14b` — POLICY VIOLATION: `qwen2.5-coder:14b` not in the approved model set',
    );
    expect(report).toContain(
      'Ollama disabled: NOT CONFIRMED — at least one recorded model attempt used a model outside the approved set.',
    );
  });

  it('renders "not confirmable" when at least one trial recorded no model attempts', () => {
    const trials = [
      trialAt('a', { modelAttempts: [{ model: 'claude-fable-5', task: 'plan', attempt: '1' }] }),
      trialAt('b', { modelAttempts: [] }),
    ];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain('- `b`: no model attempts recorded — provider evidence unavailable');
    expect(report).toContain(
      'Ollama disabled: not confirmable from recorded evidence — 1 trial(s) recorded no model attempts. A trial without recorded attempts never counts as confirmation.',
    );
  });

  it('renders the declared policy with "No trials recorded." and no verdict line for zero trials', () => {
    const report = generateBaselineReport(config, []);
    expect(report).toContain(
      'Declared policy (source: packages/config/src/defaults.ts at factory.commit): approved models `claude-fable-5`, `claude-sonnet-5`; disabled providers: `ollama`',
    );
    expect(report).not.toContain('Ollama disabled:');
  });
});

describe('GITHUB_WRITE_EVENT_KINDS', () => {
  it('pins exactly the six publishing-path event kinds', () => {
    expect([...GITHUB_WRITE_EVENT_KINDS].sort()).toEqual(
      ['await-merge', 'awaiting-review', 'human-merged', 'landed', 'merged', 'ship'].sort(),
    );
  });

  it('excludes decompose_filed and local-only-complete (local-only-run event kinds)', () => {
    expect(GITHUB_WRITE_EVENT_KINDS).not.toContain('decompose_filed');
    expect(GITHUB_WRITE_EVENT_KINDS).not.toContain('local-only-complete');
  });
});

describe('generateBaselineReport — GitHub isolation section', () => {
  const config: BaselineConfig = VALID_CONFIG;

  it('renders the Provider policy section with the literal providers.ollama: false line', () => {
    const report = generateBaselineReport(config, []);
    expect(report).toMatch(/providers\.ollama.*false/);
  });

  it('renders "confirmed" when every trial has local-only-complete and no write events', () => {
    const trials = [
      trialAt('a', {}, { runInfoPresent: false, factoryEvents: { githubWriteKinds: [], localOnlyComplete: true } }),
      trialAt('b', {}, { runInfoPresent: false, factoryEvents: { githubWriteKinds: [], localOnlyComplete: true } }),
    ];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain('## GitHub isolation');
    expect(report).toContain(
      '- `a`: run window 2026-07-28T00:00:00.000Z → 2026-07-28T00:01:00.000Z; profile `local-only`; ship `skipped`; local-only-complete recorded; no GitHub-write events',
    );
    expect(report).toContain(
      'GitHub isolation: confirmed — every trial ran under the local-only profile with SHIP skipped, recorded local-only-complete, and no GitHub-write event (issue, PR, or merge) appears in any retained events.ndjson.',
    );
  });

  it('renders NOT CONFIRMED and names the observed kind when a trial records a GitHub-write event', () => {
    const trials = [
      trialAt(
        'a',
        {},
        { runInfoPresent: false, factoryEvents: { githubWriteKinds: ['landed'], localOnlyComplete: true } },
      ),
    ];
    const report = generateBaselineReport(config, trials);
    expect(report).toContain('GITHUB-WRITE EVENTS OBSERVED: `landed`');
    expect(report).toContain(
      'GitHub isolation: NOT CONFIRMED — at least one trial records a GitHub-write event or ran outside the local-only profile.',
    );
  });

  it('renders NOT CONFIRMED when a trial ran outside the local-only profile or SHIP was not skipped', () => {
    const notLocalOnly = generateBaselineReport(config, [
      trialAt(
        'a',
        { run: { ...minimalManifest().run, profile: 'other' as never } },
        { runInfoPresent: false, factoryEvents: { githubWriteKinds: [], localOnlyComplete: true } },
      ),
    ]);
    expect(notLocalOnly).toContain('GitHub isolation: NOT CONFIRMED');

    const shipRan = generateBaselineReport(config, [
      trialAt(
        'a',
        { phases: { ...minimalManifest().phases, ship: 'ok' as never } },
        { runInfoPresent: false, factoryEvents: { githubWriteKinds: [], localOnlyComplete: true } },
      ),
    ]);
    expect(shipRan).toContain('GitHub isolation: NOT CONFIRMED');
  });

  it('renders "not confirmable" when events.ndjson is absent, empty, or unparsable', () => {
    const missing = generateBaselineReport(config, [trialAt('a', {}, { runInfoPresent: false })]);
    expect(missing).toContain('events.ndjson evidence unavailable');
    expect(missing).toContain('GitHub isolation: not confirmable from recorded evidence');

    const empty = generateBaselineReport(config, [
      trialAt('a', {}, { runInfoPresent: false, factoryEvents: { githubWriteKinds: [], localOnlyComplete: false } }),
    ]);
    expect(empty).toContain('no GitHub-write events, but no local-only-complete marker');
    expect(empty).toContain('GitHub isolation: not confirmable from recorded evidence');

    const unparsable = generateBaselineReport(config, [
      trialAt('a', {}, { runInfoPresent: false, factoryEvents: undefined }),
    ]);
    expect(unparsable).toContain('GitHub isolation: not confirmable from recorded evidence');
  });

  it('renders "No trials recorded." with no verdict line for zero trials', () => {
    const report = generateBaselineReport(config, []);
    const section = report.split('## GitHub isolation')[1].split('## Checker outcomes')[0];
    expect(section).toContain('No trials recorded.');
    expect(section).not.toContain('GitHub isolation: confirmed');
    expect(section).not.toContain('NOT CONFIRMED');
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
