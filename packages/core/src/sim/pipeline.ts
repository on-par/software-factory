// packages/core/src/sim/pipeline.ts — headless simulator: drives synthetic issue specs
// through the real PLAN -> BUILD -> CHECK -> SHIP phase functions against fake doubles
// this module owns, inside a throwaway local git workspace. No real model provider or
// GitHub call is reachable through this API by construction.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import matter from 'gray-matter';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { buildPhase } from '../phases/build.js';
import { checkPhase } from '../phases/check.js';
import { planPhase } from '../phases/plan.js';
import { shipPhase } from '../phases/ship.js';
import { ModelRouter } from '../router/index.js';
import { branchFor, cleanupWorktree, setupWorktree } from '../utils/index.js';
import { withGitLock } from '../utils/lock.js';
import {
  deriveSimSeed,
  SimJitter,
  type SimJitterConfig,
  type SimJitterDraw,
  SimJitterExecutor,
  withSimJitter,
} from './jitter.js';
import { realSimClock, type SimClock, type SimLatency } from './latency.js';
import { type SimModelCall, SimModelExecutor, type SimModelExecutorOptions, type SimModelStep } from './model.js';
import { createSimOctokit, type SimOctokitOptions, type SimRecordedCall } from './octokit.js';
import type { SimPhaseName, SimTerminalState } from './types.js';
import { createSimWorkspace, simCommitAll, type SimWorkspace } from './workspace.js';

export interface SimPipelineEvent {
  phase: SimPhaseName;
  type: string;
  msg: string;
}

export interface SimIssueSpec {
  issue: number;
  title: string;
  /** Issue body the fake GitHub client returns for this issue. */
  body?: string;
  /** Scripted model steps per task type; defaults to simDefaultScripts(issue, title). */
  scripts?: SimModelExecutorOptions['scripts'];
  /** Scripted fake-GitHub steps per endpoint; defaults to the clean built-in responses. */
  endpoints?: SimOctokitOptions['endpoints'];
  /** Passed straight to checkPhase. Defaults to true (the production default). */
  autoRework?: boolean;
  /** Passed straight to checkPhase when set. */
  maxReworkRounds?: number;
}

export interface SimIssueOutcome {
  issue: number;
  state: SimTerminalState;
  /** The phase the run ended in. 'ship' for a shipped run. */
  phase: SimPhaseName;
  route: 'codex' | 'claude';
  branch: string;
  prNumber?: number;
  reworkRounds: number;
  /** Why the run did not ship; absent when state === 'shipped'. */
  reason?: string;
  /** Every fake model call this run made — the audit trail for "no provider calls". */
  modelCalls: SimModelCall[];
  /** Every fake GitHub call this run made — the audit trail for "no GitHub calls". */
  githubCalls: SimRecordedCall[];
  /** Every jitter draw this run made, in call order. Empty when no jitter is configured. */
  jitterDraws: SimJitterDraw[];
  events: SimPipelineEvent[];
}

export interface SimulationReport {
  outcomes: SimIssueOutcome[];
  /** Count per terminal state; the three values sum to outcomes.length. */
  totals: Record<SimTerminalState, number>;
  /** Total fake model calls across the batch. A real provider call can never appear here. */
  modelCalls: number;
  /** Total fake GitHub calls across the batch. */
  githubCalls: number;
  /** Total injected failures across the batch (draws whose `failure` is non-null). */
  injectedFailures: number;
}

export interface SimulationOptions {
  issues: SimIssueSpec[];
  /** Reused across the batch when supplied (and left undisposed); otherwise one is created and disposed. */
  workspace?: SimWorkspace;
  /** owner/name used for prompts and fake octokit args. Defaults to 'on-par/software-factory-sim'. */
  repo?: string;
  /** Default per-call delay for the fake model and fake GitHub client. Defaults to none. */
  latency?: SimLatency;
  /** Injectable sleep/random so callers can keep runs deterministic. */
  clock?: SimClock;
  /** Per-phase delay + failure-rate injection. Omit for the clean path (the default).
   *  A config with 0 rate and 0 delay is behaviourally identical to omitting it. */
  jitter?: SimJitterConfig;
  /** Streamed as each phase logs, in addition to being collected on the outcome. */
  onEvent?: (issue: number, event: SimPipelineEvent) => void;
}

const DEFAULT_REPO = 'on-par/software-factory-sim';

export function simModelsConfig(): ModelsConfig {
  return {
    version: 1,
    models: {
      'stub-model': {
        provider: 'custom',
        tier: 'boss',
        costPerMtokInput: 0,
        costPerMtokOutput: 0,
        contextWindow: 1000,
        capabilities: [],
        envKey: null,
      },
    },
    tiers: { boss: ['stub-model'] },
    failover: {
      triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
      maxRetries: 2,
      cooldownMs: 0,
      escalateAfterTierExhausted: true,
    },
    routingRules: {},
  };
}

export function simRoutesConfig(): RoutesConfig {
  return {
    version: 1,
    routes: {
      plan: { tier: 'boss', description: 'sim' },
      build_claude: { tier: 'boss', description: 'sim' },
      build_codex: { tier: 'boss', description: 'sim' },
    },
  };
}

export function simSpecContent(issue: number, title: string, route: 'codex' | 'claude' = 'claude'): string {
  const frontmatter = {
    route,
    design: {
      restatedProblem: `Simulated issue #${issue}: ${title}.`,
      approach: {
        chosen: 'Apply the scripted simulation build step to the throwaway worktree.',
        rejected: [{ option: 'Leave the worktree untouched', reason: 'The issue requires a committed change.' }],
      },
      interfacesTouched: [`feature-${issue}.txt`],
      targetTypes: [{ name: `SimFeature${issue}`, file: `feature-${issue}.txt`, kind: 'added' }],
      signatures: [
        {
          symbol: `simFeature${issue}`,
          file: `feature-${issue}.txt`,
          signature: `export const simFeature${issue}: string`,
        },
      ],
      callGraph: [
        { from: 'runSimulation', to: `simFeature${issue}`, note: 'the simulated build step writes this file' },
      ],
      behaviorContract: [`feature-${issue}.txt exists in the worktree after BUILD`],
      verificationPlan: [{ command: 'true', passWhen: 'the checker sequence passes' }],
      riskBlastRadius: 'None — confined to a throwaway simulated workspace.',
      openQuestions: [],
    },
  };
  const body = `# Spec: ${title} (#${issue})
## Goal
Exercise the phase pipeline against a throwaway repository.
## Files / approach
Use the scripted simulation executor to mutate the worktree.
## Tests
Run the built-in checker sequence.
## Constitution compliance
N/A — no constitution
## Non-goals
No network calls.
`;
  return matter.stringify(body, frontmatter);
}

export function simDefaultScripts(issue: number, title: string): NonNullable<SimModelExecutorOptions['scripts']> {
  const buildStep: SimModelStep = {
    output: 'built',
    effect: async (ctx) => {
      await writeSimFeatureFile(ctx.worktree, issue);
      await simCommitAll(ctx.worktree, `feat: sim issue ${issue}`);
    },
  };
  return {
    plan: [{ output: simSpecContent(issue, title) }],
    build_claude: [buildStep],
    build_codex: [buildStep],
  };
}

async function writeSimFeatureFile(worktree: string, issue: number): Promise<void> {
  await writeFile(join(worktree, `feature-${issue}.txt`), `simulated build for issue #${issue}\n`);
}

export async function runSimulation(options: SimulationOptions): Promise<SimulationReport> {
  const owned = !options.workspace;
  const workspace = options.workspace ?? (await createSimWorkspace());
  const repo = options.repo ?? DEFAULT_REPO;
  const outcomes: SimIssueOutcome[] = [];

  try {
    for (const spec of options.issues) {
      // Sequential, on purpose — determinism is the point of this simulator; concurrency
      // belongs to the Monte Carlo runner (#566).
      outcomes.push(await runSimIssue(spec, workspace, repo, options));
    }
  } finally {
    if (owned) await workspace.dispose();
  }

  const totals: Record<SimTerminalState, number> = { shipped: 0, parked: 0, escalated: 0 };
  let modelCalls = 0;
  let githubCalls = 0;
  let injectedFailures = 0;
  for (const outcome of outcomes) {
    totals[outcome.state]++;
    modelCalls += outcome.modelCalls.length;
    githubCalls += outcome.githubCalls.length;
    injectedFailures += outcome.jitterDraws.filter((d) => d.failure !== null).length;
  }

  return { outcomes, totals, modelCalls, githubCalls, injectedFailures };
}

async function runSimIssue(
  spec: SimIssueSpec,
  workspace: SimWorkspace,
  repo: string,
  options: SimulationOptions,
): Promise<SimIssueOutcome> {
  const events: SimPipelineEvent[] = [];
  const log =
    (phase: SimPhaseName) =>
    (type: string, msg: string, _extra?: unknown): void => {
      const event: SimPipelineEvent = { phase, type, msg };
      events.push(event);
      options.onEvent?.(spec.issue, event);
    };

  const executor = new SimModelExecutor({
    scripts: spec.scripts ?? simDefaultScripts(spec.issue, spec.title),
    defaultStep: { output: '' },
    latency: options.latency,
    clock: options.clock,
  });
  const { octokit, calls: githubCalls } = createSimOctokit({
    titles: { [spec.issue]: spec.title },
    bodies: spec.body ? { [spec.issue]: spec.body } : {},
    endpoints: spec.endpoints,
    latency: options.latency,
    clock: options.clock,
  });
  const branch = branchFor(spec.issue, spec.title);
  const specPath = join(workspace.plansDir, `issue-${spec.issue}.md`);
  const worktree = `${workspace.repoRoot}-wt-${spec.issue}`;

  let phase: SimPhaseName = 'plan';
  const phaseOf = (): SimPhaseName => phase;
  const clock = options.clock ?? realSimClock;
  const jitter = options.jitter
    ? new SimJitter(options.jitter, deriveSimSeed(options.jitter.seed, spec.issue))
    : undefined;
  const routedExecutor = jitter ? new SimJitterExecutor(executor, jitter, phaseOf, clock) : executor;
  const routedOctokit = jitter ? withSimJitter(octokit, jitter, phaseOf, clock) : octokit;
  const router = new ModelRouter(simModelsConfig(), simRoutesConfig(), false, routedExecutor);
  let route: 'codex' | 'claude' = 'claude';
  let reworkRounds = 0;

  // Terminal-state mapping mirrors packages/cli/src/cli/index.ts's LaneParkError /
  // ParkReason classification — core cannot import from cli, so this is a deliberate
  // mirror, not accidental duplication. Keep it in sync with any change there.
  function finish(state: SimTerminalState, atPhase: SimPhaseName, reason?: string, prNumber?: number): SimIssueOutcome {
    return {
      issue: spec.issue,
      state,
      phase: atPhase,
      route,
      branch,
      ...(prNumber !== undefined ? { prNumber } : {}),
      reworkRounds,
      ...(reason !== undefined ? { reason } : {}),
      modelCalls: executor.calls,
      githubCalls,
      jitterDraws: jitter?.draws ?? [],
      events,
    };
  }

  try {
    const plan = await planPhase({
      issue: spec.issue,
      repo,
      worktree,
      specPath,
      router,
      constitution: null,
      octokit: routedOctokit as unknown as Octokit,
      log: log('plan'),
    });
    route = plan.route;
    if (!plan.ok) return finish('escalated', 'plan', plan.escalate ?? 'plan escalated');

    phase = 'build';
    await withGitLock(workspace.repoRoot, () => setupWorktree(workspace.repoRoot, branch, worktree));

    const build = await buildPhase({
      issue: spec.issue,
      repo,
      worktree,
      specPath,
      branch,
      route: plan.route,
      router,
      constitution: null,
      log: log('build'),
    });
    if (!build.ok) return finish('escalated', 'build', build.escalate ?? 'build escalated');

    phase = 'check';
    const check = await checkPhase({
      issue: spec.issue,
      worktree,
      specPath,
      router,
      constitution: null,
      log: log('check'),
      autoRework: spec.autoRework,
      ...(spec.maxReworkRounds !== undefined ? { maxReworkRounds: spec.maxReworkRounds } : {}),
    });
    reworkRounds = check.reworkRounds;
    if (!check.passed) {
      const reason = `${check.summary.failures} check failure(s) after ${check.reworkRounds} rework round(s)`;
      return finish(check.stuck ? 'escalated' : 'parked', 'check', reason);
    }

    phase = 'ship';
    const ship = await shipPhase({
      issue: spec.issue,
      repo,
      worktree,
      branch,
      octokit: routedOctokit as unknown as Octokit,
      watchCI: false,
      log: log('ship'),
    });
    if (!ship.ok) return finish('parked', 'ship', 'ship phase failed');
    // `shipped` means a PR was opened. shipPhase also returns ok for the alreadyDelivered
    // path (branch has no commits ahead of origin/main) — reachable here when an injected
    // BUILD failure left the worktree unchanged. That is not a ship.
    if (ship.prNumber === undefined) return finish('parked', 'ship', 'ship phase produced no PR');

    return finish('shipped', 'ship', undefined, ship.prNumber);
  } catch (err) {
    return finish('parked', phase, err instanceof Error ? err.message : String(err));
  } finally {
    await withGitLock(workspace.repoRoot, () => cleanupWorktree(workspace.repoRoot, worktree));
  }
}
