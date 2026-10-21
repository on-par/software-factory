import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectRetainedHiddenValues, findLeakedValues } from './leak-guard.js';
import { WORKSPACE_CONSTITUTION } from './workspace-constitution.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('WORKSPACE_CONSTITUTION', () => {
  it('carries frontmatter the core constitution loader can parse, plus a non-empty body', () => {
    expect(WORKSPACE_CONSTITUTION.startsWith('---\n')).toBe(true);
    const closing = WORKSPACE_CONSTITUTION.indexOf('\n---\n', 4);
    expect(closing).toBeGreaterThan(0);
    const body = WORKSPACE_CONSTITUTION.slice(closing + '\n---\n'.length);
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it('mandates clean SIGINT/SIGTERM shutdown of long-running modes', () => {
    expect(WORKSPACE_CONSTITUTION).toContain('SIGINT');
    expect(WORKSPACE_CONSTITUTION).toContain('SIGTERM');
    expect(WORKSPACE_CONSTITUTION).toMatch(/long-running/i);
    expect(WORKSPACE_CONSTITUTION).toMatch(/watch/i);
  });

  it('leaks no hidden-test name or per-problem hint', () => {
    expect(WORKSPACE_CONSTITUTION).not.toContain('test_sigint_shutdown');
    expect(WORKSPACE_CONSTITUTION).not.toContain('cfgpipe');
  });

  it('names the ADR-decided factory-authored test location', () => {
    expect(WORKSPACE_CONSTITUTION).toContain('.factory/tests/');
    expect(WORKSPACE_CONSTITUTION).toContain('ADR-0081');
  });

  it('carries v2 frontmatter', () => {
    const text = WORKSPACE_CONSTITUTION;
    expect(text.startsWith('---\n')).toBe(true);
    const closing = text.indexOf('\n---\n', 4);
    expect(closing).toBeGreaterThan(0);
    expect(text.slice(0, closing).split('\n')).toContain('version: 2');
    for (const heading of [
      'Process lifecycle',
      'CLI behavior',
      'Cross-checkpoint stability',
      'Spec-exact I/O',
      'Minimal surface',
      'Verification',
    ]) {
      expect(text).toContain(`## ${heading}`);
    }
  });

  it('states cross-checkpoint stability standards', () => {
    expect(WORKSPACE_CONSTITUTION).toMatch(/earlier increments keep working/i);
    expect(WORKSPACE_CONSTITUTION).toMatch(/existing test suite before and after/i);
    expect(WORKSPACE_CONSTITUTION).toMatch(
      /never remove or rename a documented flag, subcommand, output field,\s+or exit code/i,
    );
  });

  it('states spec-exact I/O standards', () => {
    expect(WORKSPACE_CONSTITUTION).toMatch(/byte-exactly/i);
    expect(WORKSPACE_CONSTITUTION).toMatch(/Turn each example into a test/i);
    expect(WORKSPACE_CONSTITUTION).toMatch(/error path[\s\S]*message[\s\S]*stream[\s\S]*exit code/i);
  });

  it('states minimal-surface standards', () => {
    expect(WORKSPACE_CONSTITUTION).toMatch(/speculative abstractions/i);
    expect(WORKSPACE_CONSTITUTION).toMatch(/duplicated helpers/i);
    expect(WORKSPACE_CONSTITUTION).toMatch(/dead code/i);
    expect(WORKSPACE_CONSTITUTION).toMatch(/new dependencies/i);
    expect(WORKSPACE_CONSTITUTION).toMatch(/editing the existing module/i);
  });

  it('names the pytest command', () => {
    expect(WORKSPACE_CONSTITUTION).toContain('python3 -m pytest .factory/tests');
  });

  it('stays within the 90-line budget', () => {
    expect(WORKSPACE_CONSTITUTION.trimEnd().split('\n').length).toBeLessThanOrEqual(90);
  });

  it('contains no test name retained in any evaluation.json fixture or baseline trial', () => {
    const hidden = collectRetainedHiddenValues(
      [join(REPO_ROOT, 'evals/scbench-baseline/runs'), join(REPO_ROOT, 'packages/scbench-adapter/src/__fixtures__')],
      join(REPO_ROOT, 'evals/scbench-baseline/baseline.config.json'),
    );
    expect(hidden.testNames.length).toBeGreaterThan(0);
    expect(hidden.problemIds.length).toBeGreaterThan(0);
    expect(findLeakedValues(WORKSPACE_CONSTITUTION, hidden)).toEqual([]);
  });
});
