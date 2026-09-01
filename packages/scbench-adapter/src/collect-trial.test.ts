import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

describe('collectTrial', () => {
  let outputTree: string;
  let runsDir: string;

  beforeEach(() => {
    outputTree = mkdtempSync(join(tmpdir(), 'collect-trial-output-'));
    runsDir = mkdtempSync(join(tmpdir(), 'collect-trial-runs-'));
  });

  afterEach(() => {
    rmSync(outputTree, { recursive: true, force: true });
    rmSync(runsDir, { recursive: true, force: true });
  });

  it('copies the five Factory artifacts into the trial directory', () => {
    const sourceDir = join(outputTree, 'calculator', '1');
    writeFixture(sourceDir);

    const result = collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir });

    const trialDir = join(runsDir, 'calculator', '1', 'trial-1');
    expect(result).toEqual({ sourceDir, trialDir, copied: [...FACTORY_TRIAL_FILES] });
    for (const name of FACTORY_TRIAL_FILES) {
      expect(readFileSync(join(trialDir, name), 'utf-8')).toBe(CONTENTS[name]);
    }
  });

  it('creates the trial directory when absent', () => {
    const sourceDir = join(outputTree, 'calculator', '1');
    writeFixture(sourceDir);
    const trialDir = join(runsDir, 'calculator', '1', 'trial-1');
    expect(existsSync(trialDir)).toBe(false);

    collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir });

    expect(existsSync(trialDir)).toBe(true);
    expect(existsSync(join(trialDir, 'manifest.json'))).toBe(true);
  });

  it('throws before any write when an artifact is missing from the source directory', () => {
    const sourceDir = join(outputTree, 'calculator', '1');
    writeFixture(sourceDir);
    rmSync(join(sourceDir, 'diff.patch'));

    expect(() => collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir })).toThrow(
      AdapterError,
    );
    expect(() => collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir })).toThrow(
      /diff\.patch/,
    );
    expect(existsSync(join(runsDir, 'calculator'))).toBe(false);
  });

  it('throws via the reused validator when the manifest version mismatches, without creating the trial directory', () => {
    const sourceDir = join(outputTree, 'calculator', '1');
    writeFixture(sourceDir);
    writeFileSync(join(sourceDir, 'manifest.json'), JSON.stringify(minimalManifest({ manifestVersion: 999 as never })));

    expect(() => collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir })).toThrow(
      /manifest version mismatch/,
    );
    expect(existsSync(join(runsDir, 'calculator'))).toBe(false);
  });

  it('throws via the reused validator when the manifest is unparsable, without creating the trial directory', () => {
    const sourceDir = join(outputTree, 'calculator', '1');
    writeFixture(sourceDir);
    writeFileSync(join(sourceDir, 'manifest.json'), 'not json');

    expect(() => collectTrial({ outputTree, problemId: 'calculator', checkpointId: '1', trial: 1, runsDir })).toThrow(
      /could not parse/,
    );
    expect(existsSync(join(runsDir, 'calculator'))).toBe(false);
  });
});
