import { existsSync } from 'node:fs';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { HarnessDeclaration, ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { defaultExecFn } from '../utils/exec.js';
import type { ExecFn } from '../utils/exec.js';
import { HARNESS_CHECK_RULES, ruleFor, runHarnessCheck } from './check.js';
import { CommandHarness } from './command.js';
import type { HarnessContractScenarios } from './contract.js';
import { codingHarnessContractCases } from './contract.js';

const CONFIG: ModelsConfig = {
  version: 1,
  models: {
    'fx-model': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'my-agent',
    },
  },
  tiers: { worker: ['fx-model'] },
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
  harnesses: {},
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'check-test-'));
  const script = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  script('ok.sh', 'echo ok');
  script('silent.sh', 'exit 0');
  // The commit fixtures act only on the commit prompt, like a real agent. Committing on the probe
  // prompts too would fail in the probe repo on a host with no git identity (CI).
  const onCommitPrompt = (cmd: string) => `case "$(cat)" in *HARNESS_CHECK*) ${cmd} ;; esac; echo ok`;
  script(
    'commit.sh',
    onCommitPrompt("printf 'ok\\n' > HARNESS_CHECK.txt && git add HARNESS_CHECK.txt && git commit -q -m check"),
  );
  script('edit.sh', "printf 'ok\\n' > HARNESS_CHECK.txt; echo ok");
  script('other.sh', onCommitPrompt('printf ok > other.txt && git add other.txt && git commit -q -m x'));
  // Still running when the timeout case's 1ms timer fires; every other case waits it out, so keep it short.
  script('slow.sh', 'sleep 0.2; echo ok');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function decl(script: string, agentic = false): HarnessDeclaration {
  return {
    command: join(dir, script),
    prompt: 'stdin',
    output: 'stdout',
    agentic,
    usage: 'none',
  };
}

const UNUSED: HarnessContractScenarios = {
  success: () => ({ harness: new CommandHarness('x', decl('ok.sh'), defaultExecFn) }),
  timeout: () => ({ harness: new CommandHarness('x', decl('ok.sh'), defaultExecFn) }),
  emptyOutput: () => ({ harness: new CommandHarness('x', decl('ok.sh'), defaultExecFn) }),
  failure: () => ({ harness: new CommandHarness('x', decl('ok.sh'), defaultExecFn) }),
};

const registry = new ModelRegistry(CONFIG);
const base = { id: 'my-agent', model: 'fx-model', registry };

describe('runHarnessCheck', () => {
  it('passes every case, injection cases included, for a conforming script', async () => {
    const results = await runHarnessCheck({ ...base, declaration: decl('ok.sh') });
    const expected = codingHarnessContractCases(UNUSED).length + 1;
    expect(results).toHaveLength(expected);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results[results.length - 1]).toMatchObject({
      name: 'commits a change in the worktree',
      ok: true,
      skip: 'agentic: false',
    });
  });

  const commitCase = async (script: string, execFn?: ExecFn) =>
    (await runHarnessCheck({ ...base, declaration: decl(script, true), execFn })).find(
      (r) => r.name === 'commits a change in the worktree',
    );

  it('passes the commit case for an agentic script that commits HARNESS_CHECK.txt', async () => {
    const r = await commitCase('commit.sh');
    expect(r?.ok).toBe(true);
    expect(r?.skip).toBeUndefined();
  });

  it('passes every case, the commit case included, for an agentic script that commits on the commit prompt', async () => {
    const results = await runHarnessCheck({ ...base, declaration: decl('commit.sh', true) });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.filter((r) => r.skip !== undefined)).toEqual([]);
  });

  it('fails the commit case when the agent edits but does not commit', async () => {
    const r = await commitCase('edit.sh');
    expect(r?.ok).toBe(false);
    expect(r?.error).toContain('no new commit was found');
    expect(r?.fix).toContain('commit');
    expect(r?.fix).toContain('not push');
  });

  it('fails the commit case when the agent never writes the file', async () => {
    expect((await commitCase('ok.sh'))?.error).toContain('no new commit was found');
  });

  it('fails the commit case when a different file is committed', async () => {
    expect((await commitCase('other.sh'))?.error).toContain('HARNESS_CHECK.txt is not tracked');
  });

  it('fails the commit case with the harness error when the run rejects', async () => {
    const r = await commitCase('silent.sh');
    expect(r?.ok).toBe(false);
    expect(r?.error).toContain('empty_response');
  });

  it('removes the commit scratch repo afterwards', async () => {
    const cwds = new Set<string>();
    const execFn: ExecFn = (cmd, o) => {
      if (o.cwd?.includes('factory-harness-commit-')) cwds.add(o.cwd);
      return defaultExecFn(cmd, o);
    };
    await commitCase('commit.sh', execFn);
    await commitCase('edit.sh', execFn);
    expect(cwds.size).toBeGreaterThan(0);
    for (const c of cwds) expect(existsSync(c)).toBe(false);
  });

  it('explains a silent command on the success case; the substituted cases still pass', async () => {
    const results = await runHarnessCheck({ ...base, declaration: decl('silent.sh') });
    const failed = results.filter((r) => !r.ok);
    expect(failed.map((r) => r.name)).toContain('resolves with non-empty output on success');
    const success = failed.find((r) => r.name === 'resolves with non-empty output on success');
    expect(success?.error).toContain('empty_response');
    expect(success?.rule).toContain('non-empty output');
    expect(success?.fix).toContain('output:');
    for (const name of [
      'rejects with HarnessError reason empty_response on empty output',
      'rejects with a classified reason on nonzero failure',
    ]) {
      expect(results.find((r) => r.name === name)?.ok).toBe(true);
    }
  });

  it('passes the timeout case for a slow script', async () => {
    const results = await runHarnessCheck({ ...base, declaration: decl('slow.sh') });
    expect(results.find((r) => r.name === 'rejects with HarnessError reason timeout on timeout')?.ok).toBe(true);
  });

  it('times out a fast script even when the timer fires after it exits', async () => {
    // Blocking the event loop right after spawn lets `echo ok` exit before the 1ms timer runs,
    // as on a fast Linux CI host under parallel test load.
    const lateTimerExec: ExecFn = (cmd, o) => {
      const run = defaultExecFn(cmd, o);
      const until = Date.now() + 50;
      while (Date.now() < until);
      return run;
    };
    const results = await runHarnessCheck({ ...base, declaration: decl('ok.sh'), execFn: lateTimerExec });
    for (const name of [
      'rejects with HarnessError reason timeout on timeout',
      'failure rejections carry a non-empty diagnostic message',
    ]) {
      expect(results.find((r) => r.name === name)).toMatchObject({ ok: true });
    }
  });

  it('maps every kit case name to a docs/harness-contract.md rule', async () => {
    const results = await runHarnessCheck({ ...base, declaration: decl('ok.sh') });
    for (const r of results) expect(r.rule).toContain('docs/harness-contract.md');
    expect(Object.keys(HARNESS_CHECK_RULES).length).toBeGreaterThan(0);
  });

  it('falls back for an unmapped case name', () => {
    expect(ruleFor('no such case')).toEqual({
      rule: 'docs/harness-contract.md',
      fix: 'See docs/harness-contract.md for this case.',
    });
  });

  it('removes the scratch dir afterwards', async () => {
    let cwd: string | undefined;
    const execFn: ExecFn = (cmd, o) => {
      cwd ??= o.cwd;
      return defaultExecFn(cmd, o);
    };
    await runHarnessCheck({ ...base, declaration: decl('ok.sh'), execFn });
    expect(cwd).toBeDefined();
    expect(existsSync(cwd as string)).toBe(false);
  });
});
