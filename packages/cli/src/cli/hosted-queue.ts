// packages/cli/src/cli/hosted-queue.ts — `factory hosted queue` [--url <base>]
// [--repo <slug>] [--task <text>] [--capabilities <csv>] [--authority <authority>]
// [--timeout <ms>] [--poll-interval <ms>] [--job-id <id>]
//
// Queue/tail slice (#926): queues one job to the local hosted-exec control
// plane, tails its events and summary until it reaches a terminal state, and
// prints the event progression plus the final secret-redacted result. Exits
// non-zero for failed/canceled jobs and for a non-terminal timeout. Gated by
// FACTORY_HOSTED_EXEC=1, same as the rest of hosted-exec.

import type { HostedJobClient, QueueAndTailOutcome } from '@on-par/factory-core';
import { createHttpHostedJobClient, hostedExecEnabled, queueAndTailJob } from '@on-par/factory-core';

import { applyExitCode } from './hosted.js';

export interface HostedQueueCliOptions {
  /** default 'http://127.0.0.1:8799' */
  url?: string;
  /** default 'on-par/software-factory' */
  repo?: string;
  /** opaque task payload; default 'hosted-exec: queue and tail one job (#926)' */
  task?: string;
  /** comma-separated; default 'git,node' */
  capabilities?: string;
  /** default 'repo:read' */
  authority?: string;
  /** bounded wait window in ms; default 120000 */
  timeout?: string;
  /** delay between summary polls in ms; default 1000 */
  pollInterval?: string;
  /** explicit job id (default server-generated) */
  jobId?: string;
}

export interface HostedQueueCliDeps {
  out?: { write(s: string): unknown };
  env?: NodeJS.ProcessEnv;
  /** default createHttpHostedJobClient({ baseUrl: opts.url }) */
  client?: HostedJobClient;
  /** default () => Date.now() */
  now?: () => number;
  /** default a real setTimeout-backed delay */
  sleep?: (ms: number) => Promise<void>;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Renders only QueueAndTailOutcome fields sourced from HostedJobSummary — no
 * secret material ever flows through this path (logsTail is redacted by the
 * runner, and requiredAuthority/credential handles are never included). */
export function formatQueueAndTailOutcome(outcome: QueueAndTailOutcome): string {
  const eventLines = outcome.events.map((e) => `event:    [${e.severity}] ${e.type} @ ${e.ts} — ${e.message}`);

  const summary = outcome.summary;
  const summaryLines = [
    `job:      ${summary.jobId}`,
    `repo:     ${summary.repoSlug}`,
    `status:   ${summary.status}`,
    `outcome:  ${summary.outcome ?? '(none)'}`,
    `exit:     ${summary.exitCode ?? '(none)'}`,
    `failure:  ${summary.failurePhase ?? '(none)'}`,
    `logs:     ${summary.logsTail ?? '(none)'}`,
    `artifacts: ${
      summary.artifactCount === 0
        ? '(none)'
        : summary.artifacts.map((a) => `${a.name} (${a.kind}): ${a.ref}`).join(', ')
    }`,
    `cleanup:  ${summary.cleanupProof ?? '(none)'}`,
  ];

  return [...eventLines, ...summaryLines].join('\n') + '\n';
}

/** Testable core of the command: gate on the flag, queue one job and tail it
 * to a terminal status within the bounded wait window, print the event
 * progression plus the final result. Exit code is 0 only when the terminal
 * status is 'done' — failed, canceled, and a non-terminal timeout all exit 1. */
export async function runHostedQueueCli(
  opts: HostedQueueCliOptions,
  deps: HostedQueueCliDeps = {},
): Promise<{ exitCode: number }> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? process.stdout;

  if (!hostedExecEnabled(env)) {
    out.write('hosted-exec queue refused: set FACTORY_HOSTED_EXEC=1 to enable — the local factory path is unchanged\n');
    return { exitCode: 0 };
  }

  const client = deps.client ?? createHttpHostedJobClient({ baseUrl: opts.url ?? 'http://127.0.0.1:8799' });
  const requiredCapabilities = (opts.capabilities ?? 'git,node')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const outcome = await queueAndTailJob(client, {
    repoSlug: opts.repo ?? 'on-par/software-factory',
    taskPayload: opts.task ?? 'hosted-exec: queue and tail one job (#926)',
    requiredCapabilities,
    requiredAuthority: opts.authority ?? 'repo:read',
    jobId: opts.jobId,
    timeoutMs: parsePositiveInt(opts.timeout, 120_000),
    pollIntervalMs: parsePositiveInt(opts.pollInterval, 1_000),
    now: deps.now,
    sleep: deps.sleep,
  });

  out.write(formatQueueAndTailOutcome(outcome));
  return { exitCode: outcome.status === 'done' ? 0 : 1 };
}

/** Command entry point wired up to commander. */
export async function cmdHostedQueue(opts: HostedQueueCliOptions): Promise<void> {
  const { exitCode } = await runHostedQueueCli(opts);
  applyExitCode(exitCode);
}
