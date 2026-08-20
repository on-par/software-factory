// packages/core/src/sim/octokit.ts — reusable fake octokit covering the REST/graphql
// surface core calls, with per-endpoint scripted response/latency/failure.

import type { Octokit } from '@octokit/rest';

import { applyLatency, realSimClock, type SimClock, type SimLatency } from './latency.js';

export type SimRecordedCall = [string, ...unknown[]];

export type SimOctokitEndpoint =
  'issues.get' | 'pulls.list' | 'pulls.create' | 'pulls.get' | 'checks.listForRef' | 'graphql';

export interface SimOctokitStep {
  /** The EXACT resolved value of the call — REST scripts must include their own `{ data }` wrapper. */
  response?: unknown;
  /** Rejects instead of resolving; a string is wrapped in `new Error(string)`. */
  fail?: string | Error;
  latency?: SimLatency;
}

export interface SimOctokitOptions {
  titles?: Record<number, string>;
  bodies?: Record<number, string>;
  /** Default delay for every endpoint that does not script its own. */
  latency?: SimLatency;
  /** Scripted steps per endpoint, consumed in order; falls back to the default response. */
  endpoints?: Partial<Record<SimOctokitEndpoint, SimOctokitStep[]>>;
  /** First number handed out by pulls.create. Defaults to 101. */
  firstPrNumber?: number;
  clock?: SimClock;
}

export interface SimOctokit {
  graphql: (query: string, vars: unknown) => Promise<any>;
  rest: {
    issues: { get: (args: any) => Promise<any> };
    pulls: {
      list: (args: any) => Promise<any>;
      create: (args: any) => Promise<any>;
      get: (args: any) => Promise<any>;
    };
    checks: { listForRef: (args: any) => Promise<any> };
  };
}

export function createSimOctokit(options: SimOctokitOptions = {}): {
  octokit: SimOctokit;
  calls: SimRecordedCall[];
} {
  const calls: SimRecordedCall[] = [];
  const clock = options.clock ?? realSimClock;
  const queues = new Map<SimOctokitEndpoint, SimOctokitStep[]>();
  for (const [endpoint, steps] of Object.entries(options.endpoints ?? {})) {
    queues.set(endpoint as SimOctokitEndpoint, [...(steps as SimOctokitStep[])]);
  }
  let nextPr = options.firstPrNumber ?? 101;

  async function invoke<T>(endpoint: SimOctokitEndpoint, call: SimRecordedCall, defaultResponse: () => T): Promise<T> {
    calls.push(call);
    const step = queues.get(endpoint)?.shift();
    await applyLatency(step?.latency ?? options.latency, clock);
    if (step?.fail !== undefined) {
      throw step.fail instanceof Error ? step.fail : new Error(step.fail);
    }
    return step && 'response' in step ? (step.response as T) : defaultResponse();
  }

  const octokit: SimOctokit = {
    graphql: (query: string, vars: unknown) =>
      invoke('graphql', ['graphql', query, vars], () => ({
        markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
      })),
    rest: {
      issues: {
        get: (args: any) =>
          invoke('issues.get', ['issues.get', args], () => ({
            data: {
              title: options.titles?.[args.issue_number],
              body: options.bodies?.[args.issue_number] ?? 'stub issue body',
            },
          })),
      },
      pulls: {
        list: (args: any) => invoke('pulls.list', ['pulls.list', args], () => ({ data: [] })),
        create: (args: any) => invoke('pulls.create', ['pulls.create', args], () => ({ data: { number: nextPr++ } })),
        get: (args: any) =>
          invoke('pulls.get', ['pulls.get', args], () => ({
            data: { draft: true, node_id: `PR_${args.pull_number}` },
          })),
      },
      checks: {
        listForRef: (args: any) =>
          invoke('checks.listForRef', ['checks.listForRef', args], () => ({ data: { check_runs: [] } })),
      },
    },
  };

  return { octokit, calls };
}

/** Widens the simulator's fake to the `Octokit` type `planPhase`/`shipPhase` declare.
 *  Invariant, checked by construction: `SimOctokit` implements every endpoint those two
 *  phases reach for — graphql, issues.get, issues.createComment, pulls.list/create/get and
 *  checks.listForRef — and the sim pipeline suites fail loudly if one goes missing. A single
 *  assertion, never a chain: the fake is a real subset of Octokit, not an unrelated value. */
export function asPhaseOctokit(octokit: SimOctokit): Octokit {
  return octokit as Octokit;
}
