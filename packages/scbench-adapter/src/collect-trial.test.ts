import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NATIVE_EVIDENCE_FILES } from './artifacts.js';
import { AdapterError } from './checkpoint.js';
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
    expect(result).toEqual({ sourceDir, trialDir, copied: [...FACTORY_TRIAL_FILES, ...NATIVE_EVIDENCE_FILES] });
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
});
