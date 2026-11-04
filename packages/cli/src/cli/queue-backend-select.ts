// packages/cli/src/cli/queue-backend-select.ts — Picks the QueueBackend from tracker.kind (ADR-0173 decision 10, #3918).
import {
  createLinearQueueGraphqlClient,
  createQueueBackend,
  LINEAR_API_KEY_ENV,
  resolveLinearProjectForRepo,
  resolveTrackerConfig,
  type GithubQueueBackendOptions,
  type QueueBackend,
  type QueueBackendKind,
  type TrackerConfig,
} from '@on-par/factory-core/internal';
import { CliExitError } from './errors.js';

export function selectQueueBackend(input: {
  factoryConfig: { tracker?: TrackerConfig };
  ghRepo: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Lazy so no Octokit is built in Linear mode. */
  github: () => GithubQueueBackendOptions;
  warn: (msg: string) => void;
}): { kind: QueueBackendKind; backend: QueueBackend } {
  const tracker = resolveTrackerConfig(input.factoryConfig);
  const linear = tracker.linear;
  if (tracker.kind !== 'linear' || linear === undefined) {
    return { kind: 'github', backend: createQueueBackend({ kind: 'github', github: input.github() }) };
  }
  const apiKey = input.env[LINEAR_API_KEY_ENV]?.trim();
  if (!apiKey) {
    throw new CliExitError(
      `factory: tracker.kind is linear but ${LINEAR_API_KEY_ENV} is not set — export a Linear personal API key`,
      2,
    );
  }
  let project: string | null;
  try {
    project = resolveLinearProjectForRepo(linear, input.ghRepo);
  } catch (err) {
    throw new CliExitError(`factory: ${err instanceof Error ? err.message : String(err)}`, 2);
  }
  if (project === null) {
    throw new CliExitError(
      `factory: no Linear project is mapped to ${input.ghRepo} — add one under tracker.linear.projects in .factory/config.yaml`,
      2,
    );
  }
  const client = createLinearQueueGraphqlClient({ apiKey, linear, project });
  return {
    kind: 'linear',
    backend: createQueueBackend({ kind: 'linear', linear: { client, linear, warn: input.warn } }),
  };
}
