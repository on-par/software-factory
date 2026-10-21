// packages/cli/src/cli/program-observe.ts — registers the Observe help-group commands (#2793)

import type { Command } from 'commander';
import { getFactoryPaths } from '@on-par/factory-core';
import { DEFAULT_GARDEN_MAX_CLUSTERS, DEFAULT_GARDEN_SINCE } from '@on-par/factory-core/internal';
import { runTui } from '@on-par/factory-tui';
import { BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION } from './branch-prefix.js';
import type { ClassifierBacktestOptions } from './classifier-backtest.js';
import type { CliDeps, ProgramHandlers } from './index.js';

export function registerObserveCommands(program: Command, handlers: ProgramHandlers, deps: CliDeps): void {
  program
    .command('cost')
    .description('Show recorded model spend by model (--issue for one issue)')
    .option('--issue <number>', 'Show per-entry detail for one issue')
    .option('--json', 'Print one JSON object (schemaVersion 1): rows, perModel, total; unpriced cost is null')
    .action((opts: { issue?: string; json?: boolean }) => handlers.cmdCost(opts));

  program
    .command('usage')
    .description('Report 5-hour subscription usage (falls back to a list-price estimate)')
    .option('--json', 'Print one JSON object (schemaVersion 1) instead of text')
    .action((opts: { json?: boolean }) => handlers.cmdUsage({}, opts));

  program
    .command('status')
    .description('Show active runs, the GitHub queue, provider health, and recent events')
    .option('--kpis', 'Also show the full health KPIs and the effective config')
    .option(
      '--json',
      'Print one JSON object (schemaVersion 1): repo, product, stop, breaker, active claims, update; --kpis is ignored',
    )
    .action((opts: { kpis?: boolean; json?: boolean }) => handlers.cmdStatus(opts));

  program
    .command('runs')
    .description('Print per-issue run state from the local runs directory as one JSON object, newest first (read-only)')
    .option('--json', 'Print one JSON object (schemaVersion 1) — required')
    .option('--limit <n>', 'Show at most N runs (default 50)')
    .option(
      '--diffstat <issue>',
      "Print per-file added/deleted line counts for one issue's run branch vs origin/<default branch>",
    )
    .action(async (opts: { json?: boolean; limit?: string; diffstat?: string }) => {
      await handlers.cmdRuns(opts);
    });

  program
    .command('kpis')
    .description('Compute factory health KPIs and record a trend snapshot')
    .option('--branch-prefix <prefix>', BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION)
    .action(async (opts) => {
      await handlers.cmdKpis(opts);
    });

  const classifierCmd = program
    .command('classifier')
    .description('Inspect or backtest the shadow PR classifier track record');
  classifierCmd
    .command('report')
    .description(
      'Confusion table, rule-of-three slip bounds and model-vs-floor agreement from classifier-outcomes.jsonl',
    )
    .option('--json', 'Print one JSON object with the same numbers')
    .action((opts: { json?: boolean }) => handlers.cmdClassifierReport(opts));
  classifierCmd
    .command('backtest')
    .description('Replay the floor and shadow classifier over merged factory PRs and print the outcome report')
    .requiredOption('--since <date>', 'Only PRs merged on or after this date (YYYY-MM-DD)')
    .option('--limit <n>', 'Classify at most N PRs (oldest merge first)')
    .option(
      '--labels <file>',
      'CSV of hand labels `pr,class` (class: defect|clean|gated) that override heuristic outcomes',
    )
    .option('--max-cost <usd>', 'Stop before the next PR once estimated model spend reaches this many USD')
    .option('--branch-prefix <prefix>', BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION)
    .option('--json', 'Print one JSON object instead of the table')
    .action((opts: ClassifierBacktestOptions) => handlers.cmdClassifierBacktestEntry(opts));

  program
    .command('report')
    .description('Print autonomy reports from local factory state')
    .option('--steerability', 'Steers per merged PR by lane and ISO week, with min/median/max and a histogram')
    .option('--json', 'Print one JSON object (schemaVersion 1) instead of text')
    .action((opts: { steerability?: boolean; json?: boolean }) => handlers.cmdReport(opts));

  program
    .command('risk <pr>')
    .description("Print a PR's risk tier and each matched rule (read-only)")
    .option(
      '--policy <file>',
      'Risk policy JSON validated against the risk rule schema (default: .factory/risk.yml, else the packaged rules)',
    )
    .action((pr: string, opts: { policy?: string }) => handlers.cmdRisk(pr, opts));

  program
    .command('garden')
    .description(
      'Read-only report of recurring failure patterns in local events, deduped against open issues by GitHub search',
    )
    .option('--report', 'Print recurring CHECK failure-signature clusters as markdown')
    .option('--since <duration>', 'Only consider events from this window, e.g. 7d, 36h, 2w', DEFAULT_GARDEN_SINCE)
    .option('--max-clusters <n>', 'Print at most this many clusters', String(DEFAULT_GARDEN_MAX_CLUSTERS))
    .option('--json', 'Print the same cluster data as JSON')
    .option('--out <file>', 'Write the report to this file instead of stdout')
    .option('--only-new', 'Omit clusters an open issue already tracks; keep new and tracked: unknown clusters')
    .action(
      (opts: {
        report?: boolean;
        since?: string;
        maxClusters?: string;
        json?: boolean;
        out?: string;
        onlyNew?: boolean;
      }) => handlers.cmdGarden(opts),
    );

  program
    .command('tui')
    .description('Live read-only view of the current run (q to quit)')
    .option('--local-queue', 'Read .factory/queue instead of claiming issues from GitHub Issues')
    .action((opts: { localQueue?: boolean }) => handlers.cmdTui(opts, deps.runTui ?? runTui));

  program
    .command('logs')
    .description(
      'Print pipeline events from .factory/events.ndjson (--follow to tail, --limit/--since to read only part)',
    )
    .option('--follow', 'Keep watching for new events')
    .option('--json', 'Emit one JSON object per line')
    .option('--issue <number>', 'Only show events for this issue')
    .option(
      '--limit <n>',
      'Only the newest <n> matching events (oldest first); with --since, the first <n> after the cursor',
    )
    .option('--since <cursor>', 'Only events after this cursor (the "cursor" field of a previous --json line)')
    .action(async (opts: { follow?: boolean; json?: boolean; issue?: string; limit?: string; since?: string }) => {
      const repoRoot = await handlers.getRepoRoot();
      const paths = getFactoryPaths(repoRoot);
      const { limit, ...rest } = opts;
      await handlers.cmdLogs(
        { ...rest, ...(limit !== undefined ? { limit: Number(limit) } : {}) },
        { eventsFile: paths.events },
      );
    });
}
