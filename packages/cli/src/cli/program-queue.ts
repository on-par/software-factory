// packages/cli/src/cli/program-queue.ts — registers the Queue help-group commands (#2793)

import type { Command } from 'commander';
import { BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION } from './branch-prefix.js';
import type { ProgramHandlers } from './index.js';

export function registerQueueCommands(program: Command, handlers: ProgramHandlers): void {
  program
    .command('feedback <pr-url>')
    .description("File one factory issue (bug, factory:needs-triage) from a PR's human review findings")
    .option('--note <text>', 'Use this as the issue title instead of the first finding')
    .option('--repo <owner/name>', 'Repo to file the issue in (default: filing.repo, then the origin remote)')
    .option('--include-local-paths', 'Include this host name and local design/log paths in the issue')
    .option('--branch-prefix <prefix>', BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION)
    .action(handlers.cmdFeedback);

  const filingCmd = program.command('filing').description('Inspect upstream factory reports (nothing is sent)');
  filingCmd
    .command('preview <run-id>')
    .description('Print the exact redacted [factory-report] title and body that would be sent upstream; sends nothing')
    .option('--branch-prefix <prefix>', BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION)
    .action((runId: string, opts: { branchPrefix?: string }) => handlers.cmdFilingPreview(runId, opts));

  const triage = program
    .command('triage')
    .description('Have a model propose a queue from open issues into .factory/state/queue.proposed')
    .option('--product <name>', 'Product constitution to scope triage')
    .option('--model <id>', 'Model to triage with (any registered model, Claude or Codex)')
    .action(handlers.cmdTriage);

  triage
    .command('accept')
    .description('Validate and atomically promote .factory/state/queue.proposed to .factory/state/queue')
    .option('--force', 'Skip validation and promote as-is')
    .action(async (opts) => {
      await handlers.cmdTriageAccept(opts);
    });

  program
    .command('unpark <issue>')
    .description(
      'Unpark a factory:parked issue: remove factory:parked and re-queue it in its lane with a fresh order label (same path as `queue add`)',
    )
    .option('--lane <lane>', "Lane to re-queue into (default: the issue's existing factory:lane:* label)")
    .option(
      '--json',
      'Print one JSON object (schemaVersion 1): ok, action, issue, lane, order, labelsBefore, labelsAfter',
    )
    .action(async (issue: string, opts: { lane?: string; json?: boolean }) => {
      await handlers.cmdUnpark(issue, opts);
    });

  const queue = program
    .command('queue')
    .description('Manage the GitHub-label work queue (list, add, clear, reconcile, migrate)');
  queue
    .command('migrate')
    .description('Copy valid .factory/queue lane order into GitHub issue labels')
    .option('--file <path>', 'Read the legacy queue from an explicit path instead of .factory/queue')
    .option('--dry-run', 'Print the intended label updates without mutating GitHub')
    .action((opts: { file?: string; dryRun?: boolean }) => handlers.cmdQueueMigrate(opts));
  queue
    .command('add <lane> <issues...>')
    .description(
      'Queue explicit GitHub issues into a lane — applies factory:queued + factory:lane:<lane> (and an order label), creating any missing factory labels idempotently',
    )
    .option(
      '--json',
      'Print one JSON object (schemaVersion 1): ok, action, lane, issues[{number, outcome, order, labelsAdded}], labelsCreated',
    )
    .action(async (lane: string, issues: string[], opts: { json?: boolean }) => {
      await handlers.cmdQueueAdd(lane, issues, opts);
    });
  queue
    .command('reconcile')
    .description(
      'Report queued GitHub issues that conflict with Factory App admission state, with the repair-flow pointer for each',
    )
    .option('--lane <lane>', 'Only reconcile one lane')
    .action(async (opts: { lane?: string }) => {
      await handlers.cmdQueueReconcile(opts);
    });
  queue
    .command('list')
    .description('Print queued, in-progress and parked GitHub-queue issues per lane as one JSON object (read-only)')
    .option('--json', 'Print one JSON object (schemaVersion 1) — required')
    .option('--lane <lane>', 'Only list this lane (factory:lane:<lane>)')
    .action(async (opts: { json?: boolean; lane?: string }) => {
      await handlers.cmdQueueList(opts);
    });
  queue
    .command('clear')
    .description(
      'Empty the GitHub-backed queue: removes factory:queued and factory:order:* from every unclaimed queued issue (lane labels kept; claimed issues skipped). Preview with --dry-run; limit to one lane with --lane',
    )
    .option('--dry-run', 'Print the preview and exit 0 without changing any label')
    .option('--yes', 'Confirm and remove the queue labels')
    .option('--lane <lane>', 'Only clear queued issues in this lane (factory:lane:<lane>)')
    .action(async (opts: { dryRun?: boolean; yes?: boolean; lane?: string }) => {
      await handlers.cmdQueueClear(opts);
    });

  program
    .command('check <issue>')
    .alias('ready')
    .description(
      'Check an issue before queuing: required fields and whether the size gate runs it as-is or would split it, plus an advisory INVEST report (read-only, optional --deep model review; exit 0 ready, 1 missing fields or ungradeable criteria, 2 invalid --deep output, 3 would split)',
    )
    .option(
      '--json',
      'Print one JSON object with fields, criteria findings, size verdict, INVEST findings, and reasons',
    )
    .option(
      '--deep',
      'Also call the triage-tier model once: preview the proposed split when the issue would split, otherwise suggest missing criteria and scope concerns (prints model id and cost; never files anything; exit 2 on invalid model output)',
    )
    .action(handlers.cmdCheck);
}
