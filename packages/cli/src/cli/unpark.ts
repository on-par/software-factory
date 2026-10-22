import { styleText } from 'node:util';

import { createLogger, getFactoryPaths } from '@on-par/factory-core';
import type { BlockedByItem, QueueGitHubClient, UnparkErrorCode, UnparkJson } from '@on-par/factory-core/internal';
import {
  collectBatchPrerequisites,
  createOctokitQueueClient,
  listBlockedBy,
  orderByPrerequisites,
  runUnpark,
  UnparkError,
} from '@on-par/factory-core/internal';

import { CliExitError, errorDetail, getGitHubRepo, getOctokit, getRepoRoot } from './index.js';
import type { UnparkBatchJson } from './json-contract.js';
import { renderUnparkLines } from './queue-output.js';

export type { UnparkJson } from '@on-par/factory-core/internal';
export { runUnpark, UnparkError } from '@on-par/factory-core/internal';

/** Append one `issue_unparked` event; the silent sink keeps stdout untouched. Throws on a log failure. */
export function appendUnparkEvent(result: UnparkJson, eventsFile: string): void {
  createLogger(eventsFile, { lane: result.lane, issue: result.issue }, { out: { write: () => true } }).info(
    'issue_unparked',
    `#${result.issue} unparked → ${result.lane} (order ${result.order})`,
  );
}

export interface UnparkBatchInput {
  client: QueueGitHubClient;
  owner: string;
  repo: string;
  issues: readonly number[];
  lane?: string;
  keepsFile?: string;
  warn?: (msg: string) => void;
  readIssueBody(issue: number): Promise<string>;
  listBlockedBy(issue: number): Promise<BlockedByItem[]>;
  /** Called after each successful unpark (event append); must not throw out. */
  onUnparked?: (result: UnparkJson) => void;
}

export interface UnparkBatchFailure {
  issue: number;
  code: UnparkErrorCode;
  message: string;
}

export type UnparkBatchOutcome =
  | { kind: 'cycle'; cycle: number[] }
  | { kind: 'prerequisites-unreadable'; issue: number; error: string }
  | {
      kind: 'done';
      order: number[];
      results: Array<{ ok: true; result: UnparkJson } | { ok: false; failure: UnparkBatchFailure }>;
    };

type UnparkBatchDone = Extract<UnparkBatchOutcome, { kind: 'done' }>;

/** Unpark a batch prerequisite-first; a cycle or unreadable prerequisite queues nothing, a per-issue failure does not stop the rest. */
export async function runUnparkBatch(input: UnparkBatchInput): Promise<UnparkBatchOutcome> {
  const collected = await collectBatchPrerequisites(input.issues, {
    repo: `${input.owner}/${input.repo}`,
    readIssueBody: input.readIssueBody,
    listBlockedBy: input.listBlockedBy,
  });
  if (!collected.ok) return { kind: 'prerequisites-unreadable', issue: collected.issue, error: collected.error };
  const ordered = orderByPrerequisites(input.issues, collected.prereqsOf);
  if (!ordered.ok) return { kind: 'cycle', cycle: ordered.cycle };

  const results: UnparkBatchDone['results'] = [];
  for (const issue of ordered.order) {
    try {
      const result = await runUnpark({
        client: input.client,
        owner: input.owner,
        repo: input.repo,
        issue,
        keepsFile: input.keepsFile,
        warn: input.warn,
        ...(input.lane === undefined ? {} : { lane: input.lane }),
      });
      input.onUnparked?.(result);
      results.push({ ok: true, result });
    } catch (err) {
      const code = err instanceof UnparkError ? err.code : 'unpark-failed';
      results.push({ ok: false, failure: { issue, code, message: errorDetail(err) } });
    }
  }
  return { kind: 'done', order: ordered.order, results };
}

export function formatUnparkCycle(cycle: number[]): string {
  return cycle.map((n) => `#${n}`).join(' -> ');
}

export function toUnparkBatchJson(outcome: UnparkBatchDone): UnparkBatchJson {
  const results = outcome.results.map((r) =>
    r.ok
      ? r.result
      : {
          schemaVersion: 1 as const,
          ok: false as const,
          action: 'unpark' as const,
          issue: r.failure.issue,
          error: { code: r.failure.code, message: r.failure.message },
        },
  );
  const ok = outcome.results.filter((r) => r.ok).length;
  return { schemaVersion: 1, action: 'unpark-batch', results, summary: { ok, failed: results.length - ok } };
}

export function renderUnparkBatchLines(outcome: UnparkBatchDone): string[] {
  const lines: string[] = [];
  const unparked: number[] = [];
  for (const r of outcome.results) {
    if (!r.ok) continue;
    lines.push(...renderUnparkLines(r.result));
    unparked.push(r.result.issue);
  }
  lines.push(
    `unparked ${unparked.length} of ${outcome.results.length} issue(s) in prerequisite order: ${unparked.map((n) => `#${n}`).join(', ')}`,
  );
  return lines;
}

export async function cmdUnparkBatch(issues: number[], opts: { lane?: string; json?: boolean }): Promise<void> {
  let outcome: UnparkBatchOutcome;
  try {
    const [owner, repo] = (await getGitHubRepo()).split('/');
    const octokit = getOctokit();
    const paths = getFactoryPaths(await getRepoRoot());
    outcome = await runUnparkBatch({
      client: createOctokitQueueClient(octokit),
      owner,
      repo,
      issues,
      keepsFile: paths.worktreeKeeps,
      warn: (msg) => console.error(styleText('yellow', `factory: ${msg}`)),
      ...(opts.lane === undefined ? {} : { lane: opts.lane }),
      readIssueBody: async (issue) => {
        const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: issue });
        if (
          !data ||
          typeof data !== 'object' ||
          data.number !== issue ||
          !(data.body === null || typeof data.body === 'string')
        ) {
          throw new Error(`issue #${issue} body response was malformed`);
        }
        return data.body ?? '';
      },
      listBlockedBy: (issue) => listBlockedBy({ octokit, repo: `${owner}/${repo}` }, issue),
      onUnparked: (result) => {
        try {
          appendUnparkEvent(result, paths.events);
        } catch (err) {
          console.error(styleText('yellow', `factory: unpark event not recorded — ${errorDetail(err)}`));
        }
      },
    });
  } catch (err) {
    throw new CliExitError(`factory: unpark failed — ${errorDetail(err)}`, 1);
  }
  if (outcome.kind === 'cycle') {
    throw new CliExitError(
      `factory: unpark refused — prerequisite cycle: ${formatUnparkCycle(outcome.cycle)}; nothing queued`,
      1,
    );
  }
  if (outcome.kind === 'prerequisites-unreadable') {
    throw new CliExitError(`factory: unpark refused — ${outcome.error}; nothing queued`, 1);
  }
  const failures = outcome.results.flatMap((r) => (r.ok ? [] : [r.failure]));
  for (const f of failures) console.error(`factory: unpark #${f.issue} [${f.code}] — ${f.message}`);
  if (opts.json) console.log(JSON.stringify(toUnparkBatchJson(outcome)));
  else for (const line of renderUnparkBatchLines(outcome)) console.log(line);
  if (failures.length > 0) {
    throw new CliExitError(`factory: ${failures.length} of ${outcome.results.length} issue(s) failed to unpark`, 1);
  }
}
