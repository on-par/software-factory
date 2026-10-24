// OpenCode-only end to end: a fake `opencode` CLI drives PLAN, BUILD, CHECK (with one rework round) and
// SHIP through the real ModelRouter and CliModelExecutor, on a machine where only opencode can run and FACTORY_EXPERIMENTAL is unset.
// A fake `claude` on PATH records any invocation so the test proves it is never spawned (#2635).
import { exec as execCb } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadRoutesConfig, type ModelsConfig } from '../config/index.js';
import { OPENCODE_PINNED_VERSION } from '../harness/opencode-version.js';
import { ModelRouter } from '../router/index.js';
import { makeFakeOctokit, PipelineTestKit } from '../test-support/index.js';
import { branchFor, setupWorktree } from '../utils/index.js';
import { buildPhase } from './build.js';
import { checkPhase } from './check.js';
import { planPhase } from './plan.js';
import { shipPhase } from './ship.js';
import { reworkRouteFor } from '../run/outcome.js';
import { workKeyFromIssue } from '../work/work-key.js';

const exec = promisify(execCb);
const repo = 'on-par/software-factory';
const issue = 42;

function opencodeOnlyModels(): ModelsConfig {
  const common = { costPerMtokInput: 0, costPerMtokOutput: 0, contextWindow: 100_000, capabilities: [], envKey: null };
  return {
    version: 1,
    models: {
      'fake-claude': {
        ...common,
        provider: 'anthropic',
        tier: ['boss', 'worker', 'checker'],
        harness: 'claude-cli',
        claudeFlag: 'fake-claude',
      },
      'fake-opencode': {
        ...common,
        provider: 'custom',
        tier: ['boss', 'worker', 'checker'],
        harness: 'opencode',
        providerModel: 'fake/opencode-model',
      },
    },
    tiers: {
      boss: ['fake-claude', 'fake-opencode'],
      worker: ['fake-claude', 'fake-opencode'],
      checker: ['fake-claude', 'fake-opencode'],
      triage: ['fake-claude', 'fake-opencode'],
    },
    failover: {
      triggers: ['rate_limit', 'unavailable', 'auth'],
      maxRetries: 0,
      cooldownMs: 0,
    },
    routingRules: {},
  };
}

// Fake opencode: answers PLAN with a spec that asks for the claude route, makes the first BUILD
// leave a failing verify script and the rework fix it, and answers anything else with PASS.
// Only `opencode run` (cwd = worktree) touches files. The harness's `opencode --version` probe runs
// with the test's cwd, the real repo: treating it as a BUILD committed a stub scripts/verify.sh there.
const FAKE_OPENCODE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AGENT_LOG, 'opencode ' + args.slice(0, 1).join(' ') + '\\n');
if (args[0] === '--version') {
  console.log('${OPENCODE_PINNED_VERSION}');
  process.exit(0);
}
if (args[0] !== 'run') process.exit(1);
const cwd = process.cwd();
const prompt = fs.readFileSync(0, 'utf-8');
const commit = (msg) =>
  require('node:child_process').execFileSync('sh', ['-c', 'git add -A && git -c user.name=t -c user.email=t@t commit -qm "' + msg + '"'], { cwd });
let reply = 'PASS';
if (prompt.includes('You are the PLAN phase')) {
  reply = fs.readFileSync(process.env.FAKE_SPEC_FILE, 'utf-8');
} else if (fs.existsSync(path.join(cwd, 'feature.txt')) && prompt.includes('verify')) {
  fs.writeFileSync(path.join(cwd, 'scripts', 'verify.sh'), '#!/bin/bash\\nexit 0\\n');
  commit('fix: repair verify');
  reply = 'fixed verify';
} else if (!fs.existsSync(path.join(cwd, 'feature.txt'))) {
  fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'opencode only\\n');
  fs.writeFileSync(path.join(cwd, 'scripts', 'verify.sh'), '#!/bin/bash\\necho boom >&2\\nexit 1\\n', { mode: 0o755 });
  commit('feat: opencode work');
  reply = 'built';
}
console.log(JSON.stringify({ type: 'text', part: { text: reply } }));
console.log(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 10, output: 5 } } }));
`;

const FAKE_CLAUDE = `#!/bin/sh
echo "claude $*" >> "$FAKE_AGENT_LOG"
exit 1
`;

const kit = new PipelineTestKit();
let binDir: string;
let agentLog: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'opencode-only-bin-'));
  agentLog = join(binDir, 'agents.log');
  writeFileSync(agentLog, '');
  writeFileSync(join(binDir, 'opencode'), FAKE_OPENCODE);
  writeFileSync(join(binDir, 'claude'), FAKE_CLAUDE);
  chmodSync(join(binDir, 'opencode'), 0o755);
  chmodSync(join(binDir, 'claude'), 0o755);
  savedEnv = {
    PATH: process.env.PATH,
    FAKE_AGENT_LOG: process.env.FAKE_AGENT_LOG,
    FAKE_SPEC_FILE: process.env.FAKE_SPEC_FILE,
    FACTORY_EXPERIMENTAL: process.env.FACTORY_EXPERIMENTAL,
  };
  delete process.env.FACTORY_EXPERIMENTAL;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  process.env.FAKE_AGENT_LOG = agentLog;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(binDir, { recursive: true, force: true });
  await kit.cleanup();
});

describe('OpenCode-only pipeline with a fake opencode CLI (#2635)', () => {
  it(
    'runs PLAN, BUILD, CHECK with one rework round and SHIP on opencode without FACTORY_EXPERIMENTAL',
    { timeout: 120_000 },
    async () => {
      expect(process.env.FACTORY_EXPERIMENTAL).toBeUndefined();
      const title = 'OpenCode only loop';
      const { repoRoot } = await kit.makeThrowawayRepo();
      const worktree = kit.trackWorktree(repoRoot, issue);
      const branch = branchFor(workKeyFromIssue(issue), title);
      const specPath = await kit.makeSpecPath(issue);
      const specFile = join(binDir, 'spec.md');
      writeFileSync(
        specFile,
        `---\nroute: claude\n---\n# Spec: ${title} (#${issue})\n## Goal\nProve the OpenCode-only loop.\n## Files / approach\nfeature.txt\n## Tests\nscripts/verify.sh\n## Constitution compliance\nN/A\n## Non-goals\nNone.\n`,
      );
      process.env.FAKE_SPEC_FILE = specFile;
      const { octokit } = makeFakeOctokit({ [issue]: title });
      const events: Array<[string, string]> = [];
      const log = (type: string, msg: string) => events.push([type, msg]);

      const router = new ModelRouter(opencodeOnlyModels(), loadRoutesConfig());
      // OpenCode-only machine: opencode is the only runnable CLI.
      router.skipMissingHarnessClis((cmd) => cmd === 'opencode');
      const costs: string[] = [];
      router.setCostSink((e) => costs.push(e.model));

      // opencode runs with cwd = worktree, so it must exist before PLAN (the real loop leases it first).
      await setupWorktree(repoRoot, branch, worktree);
      const plan = await planPhase({
        issue,
        repo,
        worktree,
        specPath,
        router,
        constitution: null,
        octokit: octokit as any,
        log,
      });
      expect(plan.ok).toBe(true);
      expect(plan.route).toBe('opencode');
      expect(events).toContainEqual([
        'model-override',
        'route claude has no runnable model on this machine, rerouting to opencode',
      ]);

      const build = await buildPhase({
        issue,
        repo,
        worktree,
        specPath,
        branch,
        route: plan.route,
        router,
        constitution: null,
        log,
      });
      expect(build.ok).toBe(true);
      expect(build.model).toBe('fake-opencode');

      const check = await checkPhase({
        issue,
        worktree,
        specPath,
        router,
        constitution: null,
        log,
        ...reworkRouteFor(build.route, undefined),
      });
      expect(check.passed).toBe(true);
      expect(check.reworkRounds).toBe(1);

      const ship = await shipPhase({ issue, repo, worktree, branch, octokit: octokit as any, watchCI: false, log });
      expect(ship.ok).toBe(true);
      await expect(exec(`git -C '${worktree}' log --oneline`)).resolves.toBeTruthy();

      const spawned = readFileSync(agentLog, 'utf-8');
      expect(spawned).toContain('opencode --version');
      expect(spawned).toContain('opencode run');
      expect(spawned).not.toContain('claude');
      expect(existsSync(join(worktree, 'feature.txt'))).toBe(true);

      // No attempt is ever made on a Claude model (#2635).
      expect(events.some(([type, msg]) => type === 'router' && msg.includes('Trying fake-opencode'))).toBe(true);
      expect(events.filter(([, msg]) => msg.includes('Trying fake-claude'))).toEqual([]);
      expect(events.filter(([type, msg]) => type === 'failover' && msg.includes('fake-claude'))).toEqual([]);
      expect(costs.length).toBeGreaterThan(0);
      expect(costs.every((m) => m === 'fake-opencode')).toBe(true);
    },
  );
});
