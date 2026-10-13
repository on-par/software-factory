// Codex-only end to end: a fake `codex` CLI drives PLAN, BUILD, CHECK (with one rework round) and
// SHIP through the real ModelRouter and CliModelExecutor, on a machine where claude cannot run.
// A fake `claude` on PATH records any invocation so the test proves it is never spawned (#2406).
import { exec as execCb } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadRoutesConfig, type ModelsConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { makeFakeOctokit, PipelineTestKit } from '../test-support/index.js';
import { branchFor, setupWorktree } from '../utils/index.js';
import { buildPhase } from './build.js';
import { checkPhase } from './check.js';
import { planPhase } from './plan.js';
import { shipPhase } from './ship.js';

const exec = promisify(execCb);
const repo = 'on-par/software-factory';
const issue = 41;

function codexOnlyModels(): ModelsConfig {
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
      'fake-gpt': {
        ...common,
        provider: 'openai',
        tier: ['boss', 'worker', 'checker'],
        harness: 'codex-cli',
        codex: true,
        codexFlag: '-m fake-gpt',
      },
    },
    tiers: {
      boss: ['fake-claude', 'fake-gpt'],
      worker: ['fake-claude', 'fake-gpt'],
      checker: ['fake-claude', 'fake-gpt'],
      triage: ['fake-claude', 'fake-gpt'],
    },
    failover: {
      triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
      maxRetries: 0,
      cooldownMs: 0,
      escalateAfterTierExhausted: true,
    },
    routingRules: {},
  };
}

// Fake codex: answers PLAN with a spec that asks for the claude route, makes the first BUILD
// leave a failing verify script and the rework fix it, and answers anything else with PASS.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const log = process.env.FAKE_AGENT_LOG;
fs.appendFileSync(log, 'codex ' + args.filter((a) => a !== '-').slice(0, 2).join(' ') + '\\n');
if (args[0] === 'login') process.exit(0);
const out = args[args.indexOf('-o') + 1];
const cwd = args[args.indexOf('-C') + 1];
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
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'codex only\\n');
  fs.writeFileSync(path.join(cwd, 'scripts', 'verify.sh'), '#!/bin/bash\\necho boom >&2\\nexit 1\\n', { mode: 0o755 });
  commit('feat: codex work');
  reply = 'built';
}
fs.writeFileSync(out, reply);
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
  binDir = mkdtempSync(join(tmpdir(), 'codex-only-bin-'));
  agentLog = join(binDir, 'agents.log');
  writeFileSync(agentLog, '');
  writeFileSync(join(binDir, 'codex'), FAKE_CODEX);
  writeFileSync(join(binDir, 'claude'), FAKE_CLAUDE);
  chmodSync(join(binDir, 'codex'), 0o755);
  chmodSync(join(binDir, 'claude'), 0o755);
  savedEnv = {
    PATH: process.env.PATH,
    FAKE_AGENT_LOG: process.env.FAKE_AGENT_LOG,
    FAKE_SPEC_FILE: process.env.FAKE_SPEC_FILE,
  };
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

describe('Codex-only pipeline with a fake codex CLI (#2406, #2635)', () => {
  it(
    'runs PLAN, BUILD, CHECK with one rework round and SHIP without spawning claude',
    { timeout: 120_000 },
    async () => {
      const title = 'Codex only loop';
      const { repoRoot } = await kit.makeThrowawayRepo();
      const worktree = kit.trackWorktree(repoRoot, issue);
      const branch = branchFor(issue, title);
      const specPath = await kit.makeSpecPath(issue);
      const specFile = join(binDir, 'spec.md');
      writeFileSync(
        specFile,
        `---\nroute: claude\n---\n# Spec: ${title} (#${issue})\n## Goal\nProve the Codex-only loop.\n## Files / approach\nfeature.txt\n## Tests\nscripts/verify.sh\n## Constitution compliance\nN/A\n## Non-goals\nNone.\n`,
      );
      process.env.FAKE_SPEC_FILE = specFile;
      const { octokit } = makeFakeOctokit({ [issue]: title });
      const events: Array<[string, string]> = [];
      const log = (type: string, msg: string) => events.push([type, msg]);

      const router = new ModelRouter(codexOnlyModels(), loadRoutesConfig());
      // Codex-only machine: codex is the only runnable CLI.
      router.skipMissingHarnessClis((cmd) => cmd === 'codex');
      const costs: string[] = [];
      router.setCostSink((e) => costs.push(e.model));

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
      expect(plan.route).toBe('codex');
      expect(events).toContainEqual([
        'model-override',
        'route claude has no runnable model on this machine, rerouting to codex',
      ]);

      await setupWorktree(repoRoot, branch, worktree);
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
      expect(build.model).toBe('fake-gpt');

      const check = await checkPhase({
        issue,
        worktree,
        specPath,
        router,
        constitution: null,
        log,
        reworkRoute: build.route,
      });
      expect(check.passed).toBe(true);
      expect(check.reworkRounds).toBe(1);

      const ship = await shipPhase({ issue, repo, worktree, branch, octokit: octokit as any, watchCI: false, log });
      expect(ship.ok).toBe(true);
      await expect(exec(`git -C '${worktree}' log --oneline`)).resolves.toBeTruthy();

      const spawned = readFileSync(agentLog, 'utf-8');
      expect(spawned).toContain('codex exec');
      expect(spawned).not.toContain('claude');
      expect(existsSync(join(worktree, 'feature.txt'))).toBe(true);

      // No attempt is ever made on a Claude model (#2635).
      expect(events.some(([type, msg]) => type === 'router' && msg.includes('Trying fake-gpt'))).toBe(true);
      expect(events.filter(([, msg]) => msg.includes('Trying fake-claude'))).toEqual([]);
      expect(events.filter(([type, msg]) => type === 'failover' && msg.includes('fake-claude'))).toEqual([]);
      expect(costs.length).toBeGreaterThan(0);
      expect(costs.every((m) => m === 'fake-gpt')).toBe(true);
    },
  );
});
