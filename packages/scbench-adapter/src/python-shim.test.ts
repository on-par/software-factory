// packages/scbench-adapter/src/python-shim.test.ts — cross-language conformance
// guard for the committed Python shim (#521). Runs entirely without a Python
// upstream installed (source-string assertions); optionally py_compile-checks
// the shim when python3 is on PATH.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const SHIM_PATH = fileURLToPath(new URL('../python/software_factory.py', import.meta.url));
const LAUNCHER_PATH = fileURLToPath(new URL('../python/run_scbench.py', import.meta.url));
const COMPAT_CHECK_PATH = fileURLToPath(new URL('../python/compat_check.py', import.meta.url));
const RUN_CONFIG_PATH = fileURLToPath(new URL('../scbench.run.yaml', import.meta.url));

const shim = readFileSync(SHIM_PATH, 'utf-8');
const launcher = readFileSync(LAUNCHER_PATH, 'utf-8');
const compatCheck = readFileSync(COMPAT_CHECK_PATH, 'utf-8');
const runConfig = readFileSync(RUN_CONFIG_PATH, 'utf-8');

describe('python shim conformance (pinned SCBench API)', () => {
  it('imports exclusively from the real pinned slop_code.agent_runner surface', () => {
    expect(shim).toContain('from slop_code.agent_runner.agent import Agent, AgentConfigBase');
    expect(shim).toContain('from slop_code.agent_runner.registry import register_agent');
    expect(shim).not.toContain('scbench.agents');
  });

  it('implements every abstract member of the pinned Agent ABC', () => {
    expect(shim).toContain('def _from_config');
    expect(shim).toContain('def setup');
    expect(shim).toContain('def run');
    expect(shim).toContain('def reset');
    expect(shim).toContain('def save_artifacts');
    expect(shim).toContain('def cleanup');
    expect(shim).toContain('register_agent("software_factory", SoftwareFactoryAgent)');
  });

  it('registers the config class with the required subclass kwargs', () => {
    expect(shim).toContain('agent_type="software_factory"');
    expect(shim).toContain('register=True');
  });

  it('stays in lockstep with cli-run.ts REQUIRED_FLAGS for run-checkpoint', () => {
    const requiredFlags = [
      'run-checkpoint',
      '--workspace',
      '--artifacts',
      '--task-file',
      '--problem',
      '--checkpoint',
      '--factory-bin',
    ];
    for (const flag of requiredFlags) {
      expect(shim).toContain(flag);
    }
  });

  it('declares the required run-config keys', () => {
    expect(runConfig).toContain('type: software_factory');
    expect(runConfig).toContain('cost_limits');
    expect(runConfig).toContain('environment: local-py');
  });

  it('wires the launcher to register the shim before invoking slop-code', () => {
    expect(launcher).toContain('import software_factory');
    expect(launcher).toContain('from slop_code.entrypoints.cli import app');
  });

  it('pins the compat check to the committed pin file', () => {
    expect(compatCheck).toContain('scbench.pin.json');
  });

  it('is syntactically valid Python (skipped when python3 is unavailable)', async () => {
    const probe = await execa('python3', ['--version'], { reject: false });
    if (probe.exitCode !== 0) {
      return;
    }

    for (const path of [SHIM_PATH, LAUNCHER_PATH, COMPAT_CHECK_PATH]) {
      expect(existsSync(path)).toBe(true);
    }

    const result = await execa('python3', ['-m', 'py_compile', SHIM_PATH, LAUNCHER_PATH, COMPAT_CHECK_PATH], {
      reject: false,
    });
    expect(result.exitCode).toBe(0);
  });
});
