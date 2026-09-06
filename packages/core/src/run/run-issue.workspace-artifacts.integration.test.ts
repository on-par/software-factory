// packages/core/src/run/run-issue.workspace-artifacts.integration.test.ts — #1213: proves,
// end to end and without mocking any phase, that a `factory run-brief --workspace` run
// (modeled via a direct runIssue() call over the same real ports shipIssue wires) against a
// fresh, remote-less git repo produces graded worker_output/design_smells checker results in
// manifest.json — never the "no base ref" SKIP the workspace diff-base contract (ADR-0079)
// exists to prevent.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { writeBenchmarkArtifacts, type BenchmarkManifest } from '../reports/benchmark-artifacts.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { commitAll, specContentFor } from '../test-support/index.js';
import { logEvent } from '../utils/index.js';
import { createLocalBriefAdapter, LOCAL_BRIEF_SOURCE } from '../work/local-brief.js';
import { resolveLocalOnlyPolicy } from '../work/local-only.js';
import { localOnlyWorkspace } from './ports.js';
import type { RunPolicy } from './policy.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

const ISSUE = 91213;

const VALID_BRIEF = `# Add a widget

Please add a widget that does the thing.

## Acceptance criteria

- the widget exists
`;

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runIssue — workspace artifacts integration (#1213)', () => {
  it('grades worker_output/design_smells against the captured run-start diff base, never "no base ref"', async () => {
    // 1. Workspace: a plain git repo with no origin remote, mirroring the issue's own repro
    //    recipe — origin/main and origin/master never resolve, so collectDesignDiff must fall
    //    back to the diffBase runIssue captures once via captureDiffBase (ADR-0079).
    const workspace = tempDir('factory-ws-');
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'factory@test'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'factory-test'], { cwd: workspace });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: workspace });

    const localOnlyPolicy = resolveLocalOnlyPolicy(workspace);
    const workspacePort = localOnlyWorkspace(localOnlyPolicy);

    // 2. Spec path: pre-create the plans/ parent dir — writeSpec does not mkdir the spec's
    //    own parent.
    const plansRoot = tempDir('factory-plan-');
    const plansDir = join(plansRoot, 'plans');
    mkdirSync(plansDir, { recursive: true });
    const specPath = join(plansDir, `issue-${ISSUE}.md`);

    // 3. Brief: the same VALID_BRIEF shape the CLI's --workspace tests use, resolved through
    //    the real local-brief adapter so `request.work` and the benchmark manifest's `request`
    //    field carry the same WorkRequest PLAN itself resolves.
    const briefDir = tempDir('factory-brief-');
    const briefPath = join(briefDir, 'brief.md');
    writeFileSync(briefPath, VALID_BRIEF);
    const work = await createLocalBriefAdapter().resolve({ path: briefPath });

    // 4. Router: a real ModelRouter over a minimal in-memory model set, driven by a
    //    StubModelExecutor — no network/model calls. build_codex commits a product file (the
    //    "stub worker that commits a product file" this issue's scope names); check_design
    //    returns a valid PASS verdict so designSmellsChecker actually grades the diff instead
    //    of erroring.
    const models: ModelsConfig = {
      version: 1,
      models: {
        'stub-boss': {
          provider: 'custom',
          tier: 'boss',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
        },
        'stub-worker': {
          provider: 'custom',
          tier: 'worker',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
          codex: true,
        },
      },
      tiers: { boss: ['stub-boss'], worker: ['stub-worker'] },
      failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
      routingRules: {},
    };
    const routes: RoutesConfig = {
      version: 1,
      routes: {
        plan: { tier: 'boss', description: 'stub' },
        build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
        check_design: { tier: 'boss', description: 'stub' },
      },
    };
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ output: specContentFor(ISSUE) }],
        build_codex: [
          {
            output: 'built',
            effect: async (ctx) => {
              writeFileSync(join(ctx.worktree, 'PRODUCT.md'), 'stub product output\n');
              await commitAll(ctx.worktree, 'feat: stub work');
            },
          },
        ],
        check_design: [{ output: JSON.stringify({ checker: 'design_smells', result: 'PASS', smells: [] }) }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);

    // 5. RunRequest/RunPolicy/RunPorts: the same shape shipIssue builds, with the local-brief
    //    source and localOnly: true so runIssue captures the run-start diffBase and threads it
    //    into every CHECK round instead of skipping.
    const request: RunRequest = {
      issue: ISSUE,
      repo: 'o/r',
      branch: `issue-${ISSUE}-add-a-widget`,
      specPath,
      work,
      workSource: { kind: LOCAL_BRIEF_SOURCE, params: { path: briefPath } },
      startedAt: new Date().toISOString(),
      localOnly: true,
      options: { interactive: false, autoRework: true, approvePlan: false, sandboxDisabled: false },
      timeouts: { plan: 60, build: 60, check: 60, approval: 60 },
      modelPins: { sources: {} },
      codexDisabled: false,
      skipCI: false,
      failover: { enabled: false, cooldownMs: 60_000, fallbackModel: 'claude-sonnet-5' },
      efficiency: { maxReworkRounds: 1, fastPath: false },
      processGroupGraceMs: 50,
    };

    const policy: RunPolicy = {
      models,
      routes,
      sandbox: {
        enabled: false,
        runtime: 'auto',
        network: { allow: [] },
        resources: { cpuMs: 0, memMb: 0 },
        docker: { rolloutPercent: 0 },
      },
      budget: {},
      effective: {} as RunPolicy['effective'],
    };

    const stateDir = tempDir('factory-state-');
    const eventsFile = join(stateDir, 'events.ndjson');
    const artifactsDir = tempDir('factory-artifacts-');

    const ports: RunPorts = {
      router,
      octokit: {} as Octokit,
      workspace: workspacePort,
      events: (phase) => (type, msg, extra) => logEvent(eventsFile, type, request.issue, msg, { ...extra, phase }),
      breaker: new ProviderBreaker(join(stateDir, 'breaker.json')),
      resolveConstitution: () => null,
      // The same real writeBenchmarkArtifacts (packages/core/src/reports/benchmark-artifacts.ts)
      // shipIssue wires for real `--workspace --artifacts` runs — so the manifest.json and
      // events.ndjson this test reads are produced by the same production code path.
      writeBenchmarkArtifacts: async (info) => {
        await writeBenchmarkArtifacts({
          issue: request.issue,
          artifactsDir,
          eventsFile,
          costsFile: join(stateDir, 'costs.ndjson'),
          startedAt: request.startedAt,
          outcome: info.outcome === 'parked' ? 'failed' : info.outcome,
          workspace: workspacePort.path,
          branch: info.branch,
          specPath: request.specPath,
          route: info.route,
          request: work,
          checkSummary: info.checkSummary,
          reworkRounds: info.reworkRounds,
          failure: info.failure,
          reportPath: info.reportPath,
        });
      },
    };

    const outcome = await runIssue(request, policy, ports);

    expect(outcome.state).toBe('ready');

    const manifest = JSON.parse(readFileSync(join(artifactsDir, 'manifest.json'), 'utf-8')) as BenchmarkManifest;
    const workerOutput = manifest.checker?.results.find((r) => r.checker === 'worker_output');
    expect(workerOutput?.result).toBe('PASS');

    const designSmells = manifest.checker?.results.find((r) => r.checker === 'design_smells');
    expect(designSmells?.result).toMatch(/^(PASS|FAIL)$/);
    expect(designSmells?.details).not.toContain('no base ref');

    const eventsContent = readFileSync(join(artifactsDir, 'events.ndjson'), 'utf-8');
    expect(eventsContent).not.toMatch(/SKIPPED: (worker_output|design_smells) — no base ref/);
  }, 60_000);
});
