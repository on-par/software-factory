import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NATIVE_EVIDENCE_FILES } from './artifacts.js';
import { loadBaselineConfig, collectBaselineTrials, generateBaselineReport } from './baseline.js';
import { AdapterError } from './checkpoint.js';
import { main, defaultCliDeps } from './cli-run.js';
import { collectTrial, FACTORY_TRIAL_FILES } from './collect-trial.js';
import { minimalManifest } from './manifest-fixture.js';

const CONTENTS: Record<(typeof FACTORY_TRIAL_FILES)[number], string> = {
  'manifest.json': JSON.stringify(minimalManifest()),
  'request.json': '{"request":"contents"}',
  'events.ndjson': '{"event":"one"}\n{"event":"two"}\n',
  'diff.patch': 'diff --git a/x b/x\n',
  'brief.md': '# brief\n',
};

function writeFixture(sourceDir: string) {
  mkdirSync(sourceDir, { recursive: true });
  for (const name of FACTORY_TRIAL_FILES) {
    writeFileSync(join(sourceDir, name), CONTENTS[name]);
  }
}

const NATIVE_CONTENTS: Record<(typeof NATIVE_EVIDENCE_FILES)[number], string> = {
  'evaluation.json': JSON.stringify({
    problem_name: 'calculator',
    checkpoint_name: '1',
    pass_counts: { Core: 1 },
    total_counts: { Core: 1 },
    pytest_exit_code: 0,
    infrastructure_failure: false,
  }),
  'checkpoint_results.jsonl':
    '{"problem":"calculator","checkpoint":"1","state":"ran","core_passed":1,"core_total":1}\n',
  'run_info.yaml': 'summary:\n  passed_policy: true\n',
};

function writeNativeFixture(scbenchRunDir: string) {
  mkdirSync(join(scbenchRunDir, 'calculator'), { recursive: true });
  mkdirSync(join(scbenchRunDir, 'calculator', '1'), { recursive: true });
  writeFileSync(join(scbenchRunDir, 'checkpoint_results.jsonl'), NATIVE_CONTENTS['checkpoint_results.jsonl']);
  writeFileSync(join(scbenchRunDir, 'calculator', 'run_info.yaml'), NATIVE_CONTENTS['run_info.yaml']);
  writeFileSync(join(scbenchRunDir, 'calculator', '1', 'evaluation.json'), NATIVE_CONTENTS['evaluation.json']);
}

describe('collectTrial', () => {
  let outputTree: string;
  let runsDir: string;
  let scbenchRunDir: string;

  beforeEach(() => {
    outputTree = mkdtempSync(join(tmpdir(), 'collect-trial-output-'));
    runsDir = mkdtempSync(join(tmpdir(), 'collect-trial-runs-'));
    scbenchRunDir = mkdtempSync(join(tmpdir(), 'collect-trial-scbench-'));
  });

  afterEach(() => {
    rmSync(outputTree, { recursive: true, force: true });
    rmSync(runsDir, { recursive: true, force: true });
    rmSync(scbenchRunDir, { recursive: true, force: true });
  });

  it('copies the five Factory artifacts into the trial directory', () => {
    const sourceDir = join(outputTree, 'calculator', '1');
    writeFixture(sourceDir);
    writeNativeFixture(scbenchRunDir);

    const result = collectTrial({
      outputTree,
      problemId: 'calculator',
      checkpointId: '1',
      trial: 1,
      runsDir,
      scbenchRunDir,
    });

    const trialDir = join(runsDir, 'calculator', '1', 'trial-1');
    expect(result).toEqual({
      sourceDir,
      trialDir,
      copied: [...FACTORY_TRIAL_FILES, ...NATIVE_EVIDENCE_FILES],
      alreadyImported: false,
    });
    for (const name of FACTORY_TRIAL_FILES) {
      expect(readFileSync(join(trialDir, name), 'utf-8')).toBe(CONTENTS[name]);
    }
  });

  it('creates the trial directory when absent', () => {
    const sourceDir = join(outputTree, 'calculator', '1');
    writeFixture(sourceDir);
    writeNativeFixture(scbenchRunDir);
    const trialDir = join(runsDir, 'calculator', '1', 'trial-1');
    expect(existsSync(trialDir)).toBe(false);

    collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir, scbenchRunDir });

    expect(existsSync(trialDir)).toBe(true);
    expect(existsSync(join(trialDir, 'manifest.json'))).toBe(true);
  });

  it('throws before any write when an artifact is missing from the source directory', () => {
    const sourceDir = join(outputTree, 'calculator', '1');
    writeFixture(sourceDir);
    writeNativeFixture(scbenchRunDir);
    rmSync(join(sourceDir, 'diff.patch'));

    expect(() =>
      collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir, scbenchRunDir }),
    ).toThrow(AdapterError);
    expect(() =>
      collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir, scbenchRunDir }),
    ).toThrow(/diff\.patch/);
    expect(existsSync(join(runsDir, 'calculator'))).toBe(false);
  });

  it('throws via the reused validator when the manifest version mismatches, without creating the trial directory', () => {
    const sourceDir = join(outputTree, 'calculator', '1');
    writeFixture(sourceDir);
    writeNativeFixture(scbenchRunDir);
    writeFileSync(join(sourceDir, 'manifest.json'), JSON.stringify(minimalManifest({ manifestVersion: 999 as never })));

    expect(() =>
      collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir, scbenchRunDir }),
    ).toThrow(/manifest version mismatch/);
    expect(existsSync(join(runsDir, 'calculator'))).toBe(false);
  });

  it('throws via the reused validator when the manifest is unparsable, without creating the trial directory', () => {
    const sourceDir = join(outputTree, 'calculator', '1');
    writeFixture(sourceDir);
    writeNativeFixture(scbenchRunDir);
    writeFileSync(join(sourceDir, 'manifest.json'), 'not json');

    expect(() =>
      collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir, scbenchRunDir }),
    ).toThrow(/could not parse/);
    expect(existsSync(join(runsDir, 'calculator'))).toBe(false);
  });

  describe('native evidence', () => {
    it('copies all three native evidence files byte-identical into the trial directory', () => {
      const sourceDir = join(outputTree, 'calculator', '1');
      writeFixture(sourceDir);
      writeNativeFixture(scbenchRunDir);

      const result = collectTrial({
        outputTree,
        problemId: 'calculator',
        checkpointId: '1',
        trial: 1,
        runsDir,
        scbenchRunDir,
      });

      const trialDir = join(runsDir, 'calculator', '1', 'trial-1');
      for (const name of NATIVE_EVIDENCE_FILES) {
        expect(readFileSync(join(trialDir, name), 'utf-8')).toBe(NATIVE_CONTENTS[name]);
      }
      expect(result.copied).toEqual([...FACTORY_TRIAL_FILES, ...NATIVE_EVIDENCE_FILES]);
      expect(result.alreadyImported).toBe(false);
    });

    it('throws before any write when evaluation.json is missing (checkpoint-scoped file)', () => {
      const sourceDir = join(outputTree, 'calculator', '1');
      writeFixture(sourceDir);
      writeNativeFixture(scbenchRunDir);
      rmSync(join(scbenchRunDir, 'calculator', '1', 'evaluation.json'));

      expect(() =>
        collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir, scbenchRunDir }),
      ).toThrow(AdapterError);
      expect(() =>
        collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir, scbenchRunDir }),
      ).toThrow(/evaluation\.json/);
      expect(() =>
        collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir, scbenchRunDir }),
      ).toThrow(/missing-evidence/);
      expect(existsSync(join(runsDir, 'calculator'))).toBe(false);
    });

    it('throws before any write when checkpoint_results.jsonl is missing (run-root file)', () => {
      const sourceDir = join(outputTree, 'calculator', '1');
      writeFixture(sourceDir);
      writeNativeFixture(scbenchRunDir);
      rmSync(join(scbenchRunDir, 'checkpoint_results.jsonl'));

      expect(() =>
        collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir, scbenchRunDir }),
      ).toThrow(/checkpoint_results\.jsonl/);
      expect(existsSync(join(runsDir, 'calculator'))).toBe(false);
    });

    it('throws naming all three files before any write when no native evidence exists', () => {
      const sourceDir = join(outputTree, 'calculator', '1');
      writeFixture(sourceDir);

      let error: unknown;
      try {
        collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir, scbenchRunDir });
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(AdapterError);
      const message = (error as AdapterError).message;
      for (const name of NATIVE_EVIDENCE_FILES) {
        expect(message).toContain(name);
      }
      expect(message).toContain('missing-evidence');
      expect(existsSync(join(runsDir, 'calculator'))).toBe(false);
    });
  });

  describe('idempotent re-run', () => {
    function runOnce() {
      return collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir, scbenchRunDir });
    }

    it('idempotent re-run leaves every file byte-identical and adds no entries', () => {
      const sourceDir = join(outputTree, 'calculator', '1');
      writeFixture(sourceDir);
      writeNativeFixture(scbenchRunDir);

      const first = runOnce();
      const trialDir = first.trialDir;
      const namesBefore = readdirSync(trialDir).sort();
      const contentsBefore: Record<string, string> = {};
      for (const name of namesBefore) {
        contentsBefore[name] = readFileSync(join(trialDir, name), 'utf-8');
      }

      const second = runOnce();

      expect(second).toEqual({ sourceDir, trialDir, copied: [], alreadyImported: true });
      expect(readdirSync(trialDir).sort()).toEqual([...FACTORY_TRIAL_FILES, ...NATIVE_EVIDENCE_FILES].sort());
      for (const name of namesBefore) {
        expect(readFileSync(join(trialDir, name), 'utf-8')).toBe(contentsBefore[name]);
      }
    });

    it('idempotent re-run does not rewrite a previously imported file from the source', () => {
      const sourceDir = join(outputTree, 'calculator', '1');
      writeFixture(sourceDir);
      writeNativeFixture(scbenchRunDir);

      const first = runOnce();
      const overwritten = '# overwritten prior import\n';
      writeFileSync(join(first.trialDir, 'brief.md'), overwritten);

      const second = runOnce();

      expect(second.alreadyImported).toBe(true);
      expect(readFileSync(join(first.trialDir, 'brief.md'), 'utf-8')).toBe(overwritten);
    });

    it('repeated idempotent runs succeed (second and third run)', () => {
      const sourceDir = join(outputTree, 'calculator', '1');
      writeFixture(sourceDir);
      writeNativeFixture(scbenchRunDir);

      const first = runOnce();
      const trialDir = first.trialDir;
      const namesBefore = readdirSync(trialDir).sort();
      const contentsBefore: Record<string, string> = {};
      for (const name of namesBefore) {
        contentsBefore[name] = readFileSync(join(trialDir, name), 'utf-8');
      }

      const second = runOnce();
      expect(second).toEqual({ sourceDir, trialDir, copied: [], alreadyImported: true });
      expect(readdirSync(trialDir).sort()).toEqual(namesBefore);
      for (const name of namesBefore) {
        expect(readFileSync(join(trialDir, name), 'utf-8')).toBe(contentsBefore[name]);
      }

      const third = runOnce();
      expect(third).toEqual({ sourceDir, trialDir, copied: [], alreadyImported: true });
      expect(readdirSync(trialDir).sort()).toEqual(namesBefore);
      for (const name of namesBefore) {
        expect(readFileSync(join(trialDir, name), 'utf-8')).toBe(contentsBefore[name]);
      }
    });

    it('a partial import is completed, not skipped (idempotent only when fully imported)', () => {
      const sourceDir = join(outputTree, 'calculator', '1');
      writeFixture(sourceDir);
      writeNativeFixture(scbenchRunDir);

      const first = runOnce();
      rmSync(join(first.trialDir, 'evaluation.json'));

      const second = runOnce();

      expect(second.alreadyImported).toBe(false);
      expect(second.copied).toEqual([...FACTORY_TRIAL_FILES, ...NATIVE_EVIDENCE_FILES]);
      expect(readFileSync(join(first.trialDir, 'evaluation.json'), 'utf-8')).toBe(NATIVE_CONTENTS['evaluation.json']);
    });
  });

  describe('fixture-based collection (#1151)', () => {
    const FIXTURES = fileURLToPath(new URL('./__fixtures__/collect-trial/', import.meta.url));
    const COMPLETE_OUTPUT = join(FIXTURES, 'complete', 'output');
    const COMPLETE_SCBENCH_RUN = join(FIXTURES, 'complete', 'scbench-run');
    const MISSING_OUTPUT = join(FIXTURES, 'missing-evidence', 'output');
    const MISSING_SCBENCH_RUN = join(FIXTURES, 'missing-evidence', 'scbench-run');
    const EXPECTED_FILES = [...FACTORY_TRIAL_FILES, ...NATIVE_EVIDENCE_FILES];

    function collectFixtureTrial() {
      return collectTrial({
        outputTree: COMPLETE_OUTPUT,
        problemId: 'calculator',
        checkpointId: '1',
        trial: 1,
        runsDir,
        scbenchRunDir: COMPLETE_SCBENCH_RUN,
      });
    }

    function fixtureSourcePath(name: (typeof EXPECTED_FILES)[number]): string {
      if ((FACTORY_TRIAL_FILES as readonly string[]).includes(name)) {
        return join(COMPLETE_OUTPUT, 'calculator', '1', name);
      }
      if (name === 'evaluation.json') return join(COMPLETE_SCBENCH_RUN, 'calculator', '1', name);
      if (name === 'checkpoint_results.jsonl') return join(COMPLETE_SCBENCH_RUN, name);
      return join(COMPLETE_SCBENCH_RUN, 'calculator', name);
    }

    it('copies all 8 expected files from the complete-evidence fixture byte-identical into the trial directory', () => {
      const result = collectFixtureTrial();

      const trialDir = join(runsDir, 'calculator', '1', 'trial-1');
      expect(result).toEqual({
        sourceDir: join(COMPLETE_OUTPUT, 'calculator', '1'),
        trialDir,
        copied: EXPECTED_FILES,
        alreadyImported: false,
      });
      for (const name of EXPECTED_FILES) {
        const copiedPath = join(trialDir, name);
        expect(existsSync(copiedPath)).toBe(true);
        const copied = readFileSync(copiedPath);
        const source = readFileSync(fixtureSourcePath(name));
        expect(copied.equals(source)).toBe(true);
      }
    });

    it('the real CLI collect-trial subcommand exits 2 and writes nothing for the missing-evidence fixture', async () => {
      const deps = { ...defaultCliDeps(), log: vi.fn(), logError: vi.fn() };

      const code = await main(
        [
          'collect-trial',
          '--output',
          MISSING_OUTPUT,
          '--scbench-run',
          MISSING_SCBENCH_RUN,
          '--problem',
          'calculator',
          '--checkpoint',
          '1',
          '--trial',
          '1',
          '--runs',
          runsDir,
        ],
        deps,
      );

      expect(code).toBe(2);
      expect(deps.logError).toHaveBeenCalledWith(expect.stringMatching(/evaluation\.json/));
      expect(deps.logError).toHaveBeenCalledWith(expect.stringMatching(/missing-evidence/));
      expect(readdirSync(runsDir)).toEqual([]);
    });

    it('a second collectTrial run against the already-imported fixture trial is byte-identical and copies nothing', () => {
      collectFixtureTrial();
      const trialDir = join(runsDir, 'calculator', '1', 'trial-1');
      const namesBefore = readdirSync(trialDir).sort();
      const contentsBefore = new Map(namesBefore.map((name) => [name, readFileSync(join(trialDir, name))]));

      const second = collectFixtureTrial();

      expect(second).toEqual({
        sourceDir: join(COMPLETE_OUTPUT, 'calculator', '1'),
        trialDir,
        copied: [],
        alreadyImported: true,
      });
      expect(readdirSync(trialDir).sort()).toEqual(namesBefore);
      for (const name of namesBefore) {
        expect(readFileSync(join(trialDir, name)).equals(contentsBefore.get(name)!)).toBe(true);
      }
    });

    it('generateBaselineReport over the imported fixture trials reproduces the committed golden report byte-for-byte', () => {
      collectFixtureTrial();
      const config = loadBaselineConfig(readFileSync(join(FIXTURES, 'baseline.config.json'), 'utf-8'));
      const report = generateBaselineReport(config, collectBaselineTrials(runsDir));
      const normalized = report.split(runsDir).join('<RUNS>');

      expect(normalized).toBe(readFileSync(join(FIXTURES, 'expected-report.md'), 'utf-8'));
    });
  });
});
