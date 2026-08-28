// packages/cli/src/cli/hosted-runner.ts — `factory hosted runner` [--url <base>]
// [--runner-id <id>] [--capabilities <csv>] [--timeout <ms>] [--poll-interval <ms>]
//
// Phone-home runner slice (#929): connects to the local hosted-exec control
// plane, registers its capabilities, polls within a bounded wait window, and
// leases exactly one compatible job — then exits cleanly whether or not a
// compatible job appeared. Does not execute the leased job; that is a later
// ticket. Gated by FACTORY_HOSTED_EXEC=1, same as the rest of hosted-exec.

import { randomUUID } from 'node:crypto';

import type { HostedControlPlaneClient, OneJobRunnerOutcome } from '@on-par/factory-core';
import { createHttpHostedControlPlaneClient, hostedExecEnabled, runOneJobRunner } from '@on-par/factory-core';

import { applyExitCode } from './hosted.js';

export interface HostedRunnerCliOptions {
  /** default 'http://127.0.0.1:8799' */
  url?: string;
  /** default `runner-<pid>` */
  runnerId?: string;
  /** comma-separated; default 'git,node' */
  capabilities?: string;
  /** bounded wait window in ms; default 30000 */
  timeout?: string;
  /** delay between poll attempts in ms; default 2000 */
  pollInterval?: string;
  /** lease TTL in ms; default 300000 */
  leaseTtl?: string;
  /** expected heartbeat interval in ms; default 30000 */
  heartbeatInterval?: string;
}

export interface HostedRunnerCliDeps {
  out?: { write(s: string): unknown };
  env?: NodeJS.ProcessEnv;
  /** default createHttpHostedControlPlaneClient({ baseUrl: opts.url }) */
  client?: HostedControlPlaneClient;
  /** default () => Date.now() */
  now?: () => number;
  /** default a real setTimeout-backed delay */
  sleep?: (ms: number) => Promise<void>;
  /** default randomUUID() */
  generateLeaseId?: () => string;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Renders only OneJobRunnerOutcome fields — no secret material ever flows
 * through this path (registration/lease payloads carry no credentials). */
export function formatHostedRunnerOutcome(outcome: OneJobRunnerOutcome): string {
  if (!outcome.leased) {
    return `${outcome.trace}\n`;
  }
  const lines = [
    `job:      ${outcome.jobId}`,
    `runner:   ${outcome.runner.runnerId}`,
    `lease:    ${outcome.lease?.leaseId ?? '(none)'}`,
    `status:   ${outcome.job?.status ?? '(unknown)'}`,
    `trace:    ${outcome.trace}`,
  ];
  return lines.join('\n') + '\n';
}

/** Testable core of the command: gate on the flag, register + poll for one
 * compatible job within the bounded wait window, print the result. Exits 0
 * both when a job is leased and when the window elapses with no compatible
 * work — the latter is a clean, expected outcome, not a failure. */
export async function runHostedRunnerCli(
  opts: HostedRunnerCliOptions,
  deps: HostedRunnerCliDeps = {},
): Promise<{ exitCode: number }> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? process.stdout;

  if (!hostedExecEnabled(env)) {
    out.write(
      'hosted-exec runner refused: set FACTORY_HOSTED_EXEC=1 to enable — the local factory path is unchanged\n',
    );
    return { exitCode: 0 };
  }

  const client = deps.client ?? createHttpHostedControlPlaneClient({ baseUrl: opts.url ?? 'http://127.0.0.1:8799' });
  const capabilities = (opts.capabilities ?? 'git,node')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const outcome = await runOneJobRunner(client, {
    runnerId: opts.runnerId ?? `runner-${process.pid}`,
    capabilities,
    leaseId: deps.generateLeaseId?.() ?? randomUUID(),
    ttlMs: parsePositiveInt(opts.leaseTtl, 300_000),
    heartbeatIntervalMs: parsePositiveInt(opts.heartbeatInterval, 30_000),
    timeoutMs: parsePositiveInt(opts.timeout, 30_000),
    pollIntervalMs: parsePositiveInt(opts.pollInterval, 2_000),
    now: deps.now,
    sleep: deps.sleep,
  });

  out.write(formatHostedRunnerOutcome(outcome));
  return { exitCode: 0 };
}

/** Command entry point wired up to commander. */
export async function cmdHostedRunner(opts: HostedRunnerCliOptions): Promise<void> {
  const { exitCode } = await runHostedRunnerCli(opts);
  applyExitCode(exitCode);
}
