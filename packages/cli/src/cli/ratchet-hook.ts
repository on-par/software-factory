// packages/cli/src/cli/ratchet-hook.ts — the daily ratchet hook `factory supervise` runs each cycle (#3542)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Octokit } from '@octokit/rest';
import type { FactoryConfig, getFactoryPaths } from '@on-par/factory-core';
import {
  createGithubQueue,
  createOctokitQueueClient,
  logEvent,
  RATCHET_LABEL,
  ratchetMarker,
  resolveFilingPolicy,
  resolveRatchetConfig,
  runRatchetTrigger,
  type RatchetGitHub,
} from '@on-par/factory-core/internal';

import { errorDetail, getGitHubRepo, getOctokit } from './index.js';

/** Octokit-backed RatchetGitHub, built lazily so a repo without a ratchet never resolves a token. */
export function octokitRatchetGitHub(
  repoSlug: () => Promise<string> = getGitHubRepo,
  client: () => Octokit = getOctokit,
): RatchetGitHub {
  const target = async () => {
    const [owner, repo] = (await repoSlug()).split('/');
    return { owner, repo };
  };
  return {
    async openRatchetIssues(listName) {
      const marker = ratchetMarker(listName);
      const octokit = client();
      const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
        ...(await target()),
        state: 'open',
        labels: RATCHET_LABEL,
        per_page: 100,
      });
      return issues.filter((i) => !i.pull_request && (i.body ?? '').includes(marker)).map((i) => i.number);
    },
    async fileIssue(input) {
      const { data } = await client().rest.issues.create({ ...(await target()), ...input });
      return data.number;
    },
    async enqueue(lane, issue) {
      const queue = createGithubQueue({ client: createOctokitQueueClient(client()), ...(await target()) });
      const [res] = await queue.enqueue(lane, [issue]);
      return { ok: res?.outcome !== 'failed', detail: res?.detail };
    },
  };
}

/** Fires the ratchet trigger at most once per UTC date; failures are logged, never thrown. */
export function createRatchetHook(
  repoRoot: string,
  paths: ReturnType<typeof getFactoryPaths>,
  factoryConfig: FactoryConfig,
  deps: {
    github?: RatchetGitHub;
    runRatchetTriggerFn?: typeof runRatchetTrigger;
    today?: () => string;
    emitEvent?: typeof logEvent;
  } = {},
): () => Promise<void> {
  const {
    runRatchetTriggerFn = runRatchetTrigger,
    today = () => new Date().toISOString().slice(0, 10),
    emitEvent = logEvent,
  } = deps;
  const { lists, lane } = resolveRatchetConfig(factoryConfig);
  if (lists.length === 0) return async () => {};
  const stateFile = join(paths.state, 'ratchet-last-fired');

  return async () => {
    try {
      const date = today();
      if (existsSync(stateFile) && readFileSync(stateFile, 'utf-8').trim() === date) return;
      const result = await runRatchetTriggerFn({
        lists,
        lane,
        gateLabel: resolveFilingPolicy(factoryConfig).selfFixLabel,
        readList: (file) => {
          const abs = resolve(repoRoot, file);
          return existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
        },
        github: deps.github ?? octokitRatchetGitHub(),
        log: (type, subject, message) => emitEvent(paths.events, type, subject, message),
      });
      if (result.errors.length === 0) {
        mkdirSync(paths.state, { recursive: true });
        writeFileSync(stateFile, `${date}\n`);
      }
    } catch (err) {
      emitEvent(paths.events, 'warn', 'ratchet', `ratchet trigger failed: ${errorDetail(err)}`);
    }
  };
}
