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
const BASELINE_CONFIG_PATH = fileURLToPath(
  new URL('../../../evals/scbench-baseline/baseline.config.json', import.meta.url),
);

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
    expect(runConfig).toContain('prompt: just-solve');
    expect(runConfig).toContain('thinking: none');
    expect(runConfig).toContain('pass_policy: core-cases');
  });

  it('wires the launcher to register the shim before invoking slop-code', () => {
    expect(launcher).toContain('import software_factory');
    expect(launcher).toContain('from slop_code.entrypoints.cli import app');
  });

  it('keeps scbench.run.yaml pass_policy in lockstep with baseline.config.json', () => {
    const baseline = JSON.parse(readFileSync(BASELINE_CONFIG_PATH, 'utf-8')) as {
      passPolicy: { id: string };
    };
    expect(runConfig).toContain(`pass_policy: ${baseline.passPolicy.id}`);
  });

  it('pins the compat check to the committed pin file', () => {
    expect(compatCheck).toContain('scbench.pin.json');
    expect(compatCheck).toContain('SCBENCH_PROBLEMS_PATH');
  });

  it('enforces the catalog guard at invocation time before any run', () => {
    expect(launcher).toContain('from compat_check import check_problem_catalog');
    expect(launcher).toContain('check_problem_catalog()');
    expect(launcher).toContain('sys.argv[1] == "run"');
  });

  it('sanitizes the leaked parent VIRTUAL_ENV at both process boundaries', () => {
    // Launcher: `uv run --project` sets VIRTUAL_ENV to the harness venv;
    // evaluated temp projects and Factory checkpoints must not inherit it.
    expect(launcher).toContain('os.environ.pop("VIRTUAL_ENV", None)');
    // Shim: the adapter-CLI subprocess env omits it even under entrypoints
    // that did not go through the launcher's own sanitization.
    expect(shim).toContain('if k != "VIRTUAL_ENV"');
    expect(shim).toContain('env=env');
  });

  it('refuses dirty or non-git catalog/harness checkouts', () => {
    expect(compatCheck).toContain('--porcelain');
    expect(compatCheck).toContain('SCBENCH_PIN_ALLOW_DRIFT');
    expect(compatCheck).toContain('from None');
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
