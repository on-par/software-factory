// src/hosted/runner-client.ts — Phone-home runner: registers capabilities with
// the hosted-exec control plane, polls within a bounded wait window, and
// leases exactly one compatible job (#929, parent #895/#924). The client
// boundary (`HostedControlPlaneClient`) is dependency-injected so the
// register -> poll -> lease -> exit state machine is fully testable without a
// real HTTP server: production wires `createHttpHostedControlPlaneClient`
// against the control plane started by createHostedControlPlaneServer,
// tests inject a fake client. Does not execute the leased job — that is a
// later ticket.
import type { RunnerLease } from '@on-par/contracts';

import type { HostedJobSummary } from './summary.js';

export interface RegisteredRunner {
  runnerId: string;
  capabilities: string[];
  available: boolean;
  lastHeartbeatAt: string;
}

export type PollForLeaseResult =
  { ok: true; lease: RunnerLease; job: HostedJobSummary } | { ok: false; reason: 'no-match' };

export interface HostedControlPlaneClient {
  registerRunner(input: { runnerId: string; capabilities: string[] }): Promise<RegisteredRunner>;
  pollForLease(input: {
    runnerId: string;
    capabilities: string[];
    leaseId: string;
    ttlMs: number;
    heartbeatIntervalMs: number;
  }): Promise<PollForLeaseResult>;
}

/** Structurally identical to the router's FetchFn — defined here so this
 * module does not import from ../router (avoids an import cycle). */
export type HostedControlPlaneFetchFn = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface HttpHostedControlPlaneClientOptions {
  /** e.g. 'http://127.0.0.1:8799'. Trailing slash tolerated. */
  baseUrl: string;
  /** default globalThis.fetch */
  fetchImpl?: HostedControlPlaneFetchFn;
}

/** Production client: talks to a running createHostedControlPlaneServer over
 * HTTP. Throws on transport/HTTP failure — the caller decides how to react. */
export function createHttpHostedControlPlaneClient(
  options: HttpHostedControlPlaneClientOptions,
): HostedControlPlaneClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl: HostedControlPlaneFetchFn = options.fetchImpl ?? globalThis.fetch;

  async function post(path: string, body: unknown): Promise<unknown> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      const message =
        data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : res.status;
      throw new Error(`hosted control plane ${path} failed: ${message}`);
    }
    return data;
  }

  return {
    async registerRunner(input) {
      const data = (await post('/runners', input)) as { runner: RegisteredRunner };
      return data.runner;
    },
    async pollForLease(input) {
      const { runnerId, ...body } = input;
      const data = (await post(`/runners/${encodeURIComponent(runnerId)}/poll`, body)) as PollForLeaseResult;
      return data;
    },
  };
}

export interface OneJobRunnerConfig {
  runnerId: string;
  capabilities: string[];
  leaseId: string;
  ttlMs: number;
  heartbeatIntervalMs: number;
  /** Bounded wait window for polling before giving up with no lease. Default 30_000. */
  timeoutMs?: number;
  /** Delay between poll attempts. Default 2_000. */
  pollIntervalMs?: number;
  /** default () => Date.now() */
  now?: () => number;
  /** default a real setTimeout-backed delay */
  sleep?: (ms: number) => Promise<void>;
}

export interface OneJobRunnerOutcome {
  leased: boolean;
  runner: RegisteredRunner;
  attempts: number;
  jobId?: string;
  lease?: RunnerLease;
  job?: HostedJobSummary;
  trace: string;
}

/** Registers once, then polls for a compatible job within a bounded wait
 * window, leasing at most one job. Exits (returns) cleanly — leased or not —
 * once a lease is acquired or the window elapses; never loops past that. */
export async function runOneJobRunner(
  client: HostedControlPlaneClient,
  config: OneJobRunnerConfig,
): Promise<OneJobRunnerOutcome> {
  const timeoutMs = config.timeoutMs ?? 30_000;
  const pollIntervalMs = config.pollIntervalMs ?? 2_000;
  const now = config.now ?? (() => Date.now());
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const runner = await client.registerRunner({ runnerId: config.runnerId, capabilities: config.capabilities });

  const deadline = now() + timeoutMs;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const poll = await client.pollForLease({
      runnerId: config.runnerId,
      capabilities: config.capabilities,
      leaseId: config.leaseId,
      ttlMs: config.ttlMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
    });

    if (poll.ok) {
      return {
        leased: true,
        runner,
        attempts,
        jobId: poll.job.jobId,
        lease: poll.lease,
        job: poll.job,
        trace: `registered ${config.runnerId} -> leased ${poll.job.jobId} after ${attempts} poll(s)`,
      };
    }

    if (now() >= deadline) {
      return {
        leased: false,
        runner,
        attempts,
        trace: `registered ${config.runnerId} -> no compatible job within ${timeoutMs}ms (${attempts} poll(s))`,
      };
    }

    await sleep(pollIntervalMs);
  }
}
