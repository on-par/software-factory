// src/hosted/queue-client.ts — Queue-side counterpart to runner-client.ts:
// queues one job to the hosted-exec control plane (#924) and tails it to a
// terminal state (#926, parent #895). The client boundary (`HostedJobClient`)
// is dependency-injected so the create -> poll -> collect-events state
// machine is fully testable without a real HTTP server: production wires
// `createHttpHostedJobClient` against the control plane started by
// createHostedControlPlaneServer, tests inject a fake client.
import type { HostedJobEvent, HostedJobStatus } from '@on-par/contracts';

import type { HostedControlPlaneFetchFn } from './runner-client.js';
import type { HostedJobSummary } from './summary.js';

/** Linear-time trim (no regex) — baseUrl is caller-supplied library input, so a
 * `/\/+$/`-style pattern would flag as a polynomial-regex-on-untrusted-input risk. */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

const TERMINAL_STATUSES: ReadonlySet<HostedJobStatus> = new Set(['done', 'failed', 'canceled']);

function isTerminalStatus(status: HostedJobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface HostedJobClient {
  createJob(input: {
    repoSlug: string;
    taskPayload: string;
    requiredCapabilities: string[];
    requiredAuthority: string;
    jobId?: string;
  }): Promise<HostedJobSummary>;
  getJob(jobId: string): Promise<HostedJobSummary>;
  getEvents(jobId: string): Promise<HostedJobEvent[]>;
}

export interface HttpHostedJobClientOptions {
  /** e.g. 'http://127.0.0.1:8799'. Trailing slash tolerated. */
  baseUrl: string;
  /** default globalThis.fetch */
  fetchImpl?: HostedControlPlaneFetchFn;
}

/** Production client: talks to a running createHostedControlPlaneServer over
 * HTTP. Throws on transport/HTTP failure — the caller decides how to react. */
export function createHttpHostedJobClient(options: HttpHostedJobClientOptions): HostedJobClient {
  const baseUrl = trimTrailingSlashes(options.baseUrl);
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
      throw new Error(`hosted job client ${path} failed: ${message}`);
    }
    return data;
  }

  async function get(path: string): Promise<unknown> {
    const res = await fetchImpl(`${baseUrl}${path}`, { method: 'GET' });
    const data = await res.json();
    if (!res.ok) {
      const message =
        data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : res.status;
      throw new Error(`hosted job client ${path} failed: ${message}`);
    }
    return data;
  }

  return {
    async createJob(input) {
      const data = (await post('/jobs', input)) as { job: HostedJobSummary };
      return data.job;
    },
    async getJob(jobId) {
      const data = (await get(`/jobs/${encodeURIComponent(jobId)}`)) as { job: HostedJobSummary };
      return data.job;
    },
    async getEvents(jobId) {
      const data = (await get(`/jobs/${encodeURIComponent(jobId)}/events`)) as { events: HostedJobEvent[] };
      return data.events;
    },
  };
}

export interface QueueAndTailConfig {
  repoSlug: string;
  taskPayload: string;
  requiredCapabilities: string[];
  requiredAuthority: string;
  jobId?: string;
  /** Bounded wait window for polling to a terminal status. Default 120_000. */
  timeoutMs?: number;
  /** Delay between summary polls. Default 1_000. */
  pollIntervalMs?: number;
  /** default () => Date.now() */
  now?: () => number;
  /** default a real setTimeout-backed delay */
  sleep?: (ms: number) => Promise<void>;
}

export interface QueueAndTailOutcome {
  jobId: string;
  terminal: boolean;
  status: HostedJobStatus;
  summary: HostedJobSummary;
  events: HostedJobEvent[];
  trace: string;
}

/** Creates one job, polls its summary within a bounded wait window until it
 * reaches a terminal status (or the window elapses), then reads the full
 * ordered event list once. Never loops past the deadline. */
export async function queueAndTailJob(
  client: HostedJobClient,
  config: QueueAndTailConfig,
): Promise<QueueAndTailOutcome> {
  const timeoutMs = config.timeoutMs ?? 120_000;
  const pollIntervalMs = config.pollIntervalMs ?? 1_000;
  const now = config.now ?? (() => Date.now());
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let summary = await client.createJob({
    repoSlug: config.repoSlug,
    taskPayload: config.taskPayload,
    requiredCapabilities: config.requiredCapabilities,
    requiredAuthority: config.requiredAuthority,
    jobId: config.jobId,
  });
  const jobId = summary.jobId;
  const deadline = now() + timeoutMs;

  for (;;) {
    if (isTerminalStatus(summary.status)) break;
    if (now() >= deadline) break;
    await sleep(pollIntervalMs);
    summary = await client.getJob(jobId);
  }

  const events = await client.getEvents(jobId);
  const terminal = isTerminalStatus(summary.status);

  return {
    jobId,
    terminal,
    status: summary.status,
    summary,
    events,
    trace: `queued ${jobId} -> ${summary.status}`,
  };
}
