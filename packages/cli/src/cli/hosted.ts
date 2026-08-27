// packages/cli/src/cli/hosted.ts — `factory hosted smoke` [--repo <slug>] [--image <image>]
//
// Local end-to-end hosted-exec smoke: create -> lease -> disposable Docker run
// against a fresh clone -> terminal result -> cleanup proof (#923). Gated by
// FACTORY_HOSTED_EXEC=1 — refuses to run and leaves the local factory path
// unchanged when the flag is off, and cleanly skips when Docker is unavailable.

import { hostedExecEnabled } from '@on-par/contracts';
import type { ContainerEngine, HostedClock, HostedSmokeOutcome } from '@on-par/factory-core';
import { isCommandAvailable, runHostedSmoke } from '@on-par/factory-core';
import { createDockerEngine } from '@on-par/factory-core/internal';

export interface HostedSmokeCliOptions {
  /** default 'on-par/software-factory' */
  repo?: string;
  /** default 'node:20-alpine' */
  image?: string;
}

export interface HostedSmokeCliDeps {
  out?: { write(s: string): unknown };
  env?: NodeJS.ProcessEnv;
  /** default () => isCommandAvailable('docker') */
  dockerAvailable?: () => boolean;
  /** default createDockerEngine({}) */
  engine?: ContainerEngine;
  /** default () => Date.now() */
  now?: HostedClock;
}

// Minimal, read-only, factory-safe command run against the fresh clone at /workspace/repo.
const DEFAULT_SMOKE_COMMAND = ['sh', '-c', 'ls -a /workspace/repo && echo hosted-exec-smoke-ok'];

/** Renders only the secret-free HostedJobSummary fields — never any other field of the
 * outcome — so no secret value from the underlying store/engine can reach output. */
export function formatHostedSmokeSummary(outcome: HostedSmokeOutcome): string {
  if (!outcome.enabled) {
    return `${outcome.trace}\n`;
  }

  const summary = outcome.summary;
  if (!summary) {
    return `${outcome.trace}\n`;
  }

  const lines = [
    `job:      ${outcome.jobId ?? summary.jobId}`,
    `repo:     ${summary.repoSlug}`,
    `lease:    ${outcome.leaseId ?? '(none)'}`,
    `outcome:  ${summary.outcome ?? summary.status}`,
    `exit:     ${summary.exitCode ?? '(none)'}`,
    `logs:     ${summary.logsTail ?? '(none)'}`,
    `artifacts: ${
      summary.artifactCount === 0
        ? '(none)'
        : summary.artifacts.map((a) => `${a.name} (${a.kind}): ${a.ref}`).join(', ')
    }`,
    `cleanup:  ${summary.cleanupProof ?? '(none)'}`,
  ];
  return lines.join('\n') + '\n';
}

/** Testable core of the command: gate on the flag, gate on docker availability, run the
 * smoke, print the result. Returns the exit code the CLI wrapper should use. */
export async function runHostedSmokeCli(
  opts: HostedSmokeCliOptions,
  deps: HostedSmokeCliDeps = {},
): Promise<{ exitCode: number }> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? process.stdout;

  if (!hostedExecEnabled(env)) {
    out.write('hosted-exec smoke refused: set FACTORY_HOSTED_EXEC=1 to enable — the local factory path is unchanged\n');
    return { exitCode: 0 };
  }

  const dockerAvailable = deps.dockerAvailable ?? (() => isCommandAvailable('docker'));
  if (!dockerAvailable()) {
    out.write('docker not available — skipping hosted-exec smoke\n');
    return { exitCode: 0 };
  }

  const engine = deps.engine ?? createDockerEngine({});
  const outcome = await runHostedSmoke(engine, {
    repoSlug: opts.repo ?? 'on-par/software-factory',
    image: opts.image ?? 'node:20-alpine',
    command: DEFAULT_SMOKE_COMMAND,
    now: deps.now ?? (() => Date.now()),
    env,
  });

  out.write(formatHostedSmokeSummary(outcome));
  return { exitCode: outcome.summary?.outcome === 'completed' ? 0 : 1 };
}

/** Command entry point wired up to commander. */
export async function cmdHostedSmoke(opts: HostedSmokeCliOptions): Promise<void> {
  const { exitCode } = await runHostedSmokeCli(opts);
  if (exitCode !== 0) process.exit(exitCode);
}
