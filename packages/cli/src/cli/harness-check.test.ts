import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyRepoConfig, loadModelsConfig, loadRepoConfig, ModelRegistry } from '@on-par/factory-core';
import { runHarnessCheck } from '@on-par/factory-core/internal';
import { afterEach, describe, expect, it } from 'vitest';

import type { HarnessCheckCommandDeps } from './harness-check.js';
import { formatHarnessCheckResults, runHarnessCheckCommand } from './harness-check.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeRepo(body: string, withModel = true, agentic = false): HarnessCheckCommandDeps {
  const root = mkdtempSync(join(tmpdir(), 'harness-check-cli-'));
  roots.push(root);
  const script = join(root, 'agent.sh');
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  mkdirSync(join(root, '.factory'));
  const registry = withModel
    ? `
models:
  registry:
    fx-model:
      provider: custom
      tier: worker
      costPerMtokInput: 0
      costPerMtokOutput: 0
      contextWindow: 1000
      capabilities: []
      envKey: null
      harness: my-agent
`
    : '';
  writeFileSync(
    join(root, '.factory', 'config.yaml'),
    `version: 2
harnesses:
  my-agent:
    command: ${script}
    prompt: stdin
    output: stdout
    agentic: ${agentic}
    usage: none
${registry}`,
  );
  return {
    repoRoot: root,
    loadModelsConfig,
    loadRepoConfig,
    applyRepoConfig,
    runHarnessCheck,
    registryClass: ModelRegistry,
  };
}

describe('runHarnessCheckCommand', () => {
  it('passes every case for a fixture script that prints ok', async () => {
    const { output, exitCode } = await runHarnessCheckCommand('my-agent', {}, makeRepo('echo ok'));
    const caseLines = output.split('\n').filter((l) => !l.startsWith('    ') && !/ passed, /.test(l));
    expect(caseLines.length).toBeGreaterThan(0);
    const skips = caseLines.filter((l) => l.startsWith('SKIP'));
    expect(skips).toEqual(['SKIP commits a change in the worktree (agentic: false)']);
    for (const l of caseLines.filter((l) => !l.startsWith('SKIP'))) expect(l.startsWith('PASS')).toBe(true);
    expect(exitCode).toBe(0);
  });

  const COMMIT = 'commits a change in the worktree';
  const line = (output: string) => output.split('\n').find((l) => l.includes(COMMIT)) ?? '';

  it('passes the commit case for an agentic fixture that commits HARNESS_CHECK.txt', async () => {
    const body = "printf 'ok\\n' > HARNESS_CHECK.txt && git add HARNESS_CHECK.txt && git commit -q -m check && echo ok";
    const { output, exitCode } = await runHarnessCheckCommand('my-agent', {}, makeRepo(body, true, true));
    expect(line(output).startsWith('PASS')).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('fails the commit case with the commit-locally fix when the agent edits but does not commit', async () => {
    const { output, exitCode } = await runHarnessCheckCommand(
      'my-agent',
      {},
      makeRepo("printf 'ok\\n' > HARNESS_CHECK.txt; echo ok", true, true),
    );
    expect(line(output).startsWith('FAIL')).toBe(true);
    expect(line(output)).toContain('no new commit was found');
    expect(output).toMatch(/fix: .*commit.*not push/);
    expect(exitCode).toBe(1);
  });

  it('skips the commit case for an agentic false harness without changing the exit code', async () => {
    const { output, exitCode } = await runHarnessCheckCommand('my-agent', {}, makeRepo('echo ok', true, false));
    expect(line(output)).toBe(`SKIP ${COMMIT} (agentic: false)`);
    expect(exitCode).toBe(0);
  });

  it('explains a silent command with empty_response, the non-empty output rule and the output fix', async () => {
    const { output, exitCode } = await runHarnessCheckCommand('my-agent', {}, makeRepo('exit 0'));
    const line = output.split('\n').find((l) => l.includes('resolves with non-empty output on success'));
    expect(line?.startsWith('FAIL')).toBe(true);
    expect(line).toContain('empty_response');
    expect(output).toContain('non-empty output');
    expect(output).toContain('output:');
    expect(exitCode).toBe(1);
  });

  it('rejects an undeclared id and lists the declared ids', async () => {
    const { output, exitCode } = await runHarnessCheckCommand('nope', {}, makeRepo('echo ok'));
    expect(output).toContain("no declared harness 'nope'");
    expect(output).toContain('my-agent');
    expect(exitCode).toBe(1);
  });

  it('asks for a model when no registry entry runs on the harness', async () => {
    const { output, exitCode } = await runHarnessCheckCommand('my-agent', {}, makeRepo('echo ok', false));
    expect(output).toContain("needs a model on 'my-agent'");
    expect(exitCode).toBe(1);
  });

  it('rejects an unknown --model', async () => {
    const { output, exitCode } = await runHarnessCheckCommand('my-agent', { model: 'zzz' }, makeRepo('echo ok'));
    expect(output).toContain("unknown model 'zzz'");
    expect(exitCode).toBe(1);
  });

  it('rejects a --model that runs on another harness', async () => {
    const deps = makeRepo('echo ok');
    const models = Object.keys(loadModelsConfig().models);
    const other = models.find((m) => loadModelsConfig().models[m].harness !== 'my-agent') as string;
    const { output, exitCode } = await runHarnessCheckCommand('my-agent', { model: other }, deps);
    expect(output).toContain(`model '${other}' runs on harness`);
    expect(output).toContain("not 'my-agent'");
    expect(exitCode).toBe(1);
  });
});

describe('formatHarnessCheckResults', () => {
  it('prints PASS and FAIL lines with rule, fix and a summary', () => {
    const out = formatHarnessCheckResults([
      { name: 'a', ok: true, rule: 'r', fix: 'f' },
      { name: 'b', ok: false, rule: 'rule-b', fix: 'fix-b', error: 'boom' },
    ]);
    expect(out).toBe('PASS a\nFAIL b: boom\n    rule: rule-b\n    fix: fix-b\n1 passed, 1 failed');
  });

  it('prints SKIP lines and a skipped count', () => {
    const out = formatHarnessCheckResults([
      { name: 'a', ok: true, rule: 'r', fix: 'f' },
      { name: 'b', ok: false, rule: 'rule-b', fix: 'fix-b', error: 'boom' },
      { name: 'c', ok: true, rule: 'r', fix: 'f', skip: 'agentic: false' },
    ]);
    expect(out).toContain('SKIP c (agentic: false)');
    expect(out.endsWith('1 passed, 1 failed, 1 skipped')).toBe(true);
  });
});
