// packages/cli/src/cli/program-run-work.ts — registers the Run work help-group commands (#2793)

import type { Command } from 'commander';
import { LEGACY_BRANCH_PREFIX } from '@on-par/factory-core/internal';
import { BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION, BRANCH_PREFIX_OPTION_DESCRIPTION } from './branch-prefix.js';
import type { ProgramHandlers } from './index.js';
import type { SteerOptions } from './steer.js';

export function registerRunWorkCommands(program: Command, handlers: ProgramHandlers): void {
  program
    .command('ship <issue>')
    .description(
      'Plan → build → check one GitHub issue and open a ready-for-review PR; never merges (merge later with land)',
    )
    .option('--product <name>', 'Override active product constitution')
    .option('--no-auto-rework', 'Disable automatic rework loop')
    .option('--interactive', 'Pause before opening the PR and wait for approval from the TUI')
    .option(
      '--no-pr',
      'Stop after a clean CHECK: no SHIP, push, PR, or other GitHub write (size gate off); the worktree is kept',
    )
    .option('--approve-plan', 'Pause after PLAN freezes the spec and wait for approval before BUILD')
    .option('--no-sandbox', 'Disable the containment sandbox for agent runs (dangerous)')
    .option(
      '--draft-pr',
      'Stop SHIP at a draft PR: skip mark-ready and auto-merge, overriding run.pr.draft in the repo config',
    )
    .option('--no-draft-pr', 'Mark the PR ready for review after CI, overriding run.pr.draft in the repo config')
    .option('--branch-prefix <prefix>', BRANCH_PREFIX_OPTION_DESCRIPTION)
    .action(async (issueNum, opts) => {
      await handlers.cmdShip(handlers.parseIssueArg(issueNum), opts);
    });

  program
    .command('run-issue <issue>')
    .description('Like ship, but loads the issue first and exits 2 before any worktree or PR if it cannot be found')
    .option('--product <name>', 'Override active product constitution')
    .option('--no-auto-rework', 'Disable automatic rework loop')
    .option('--interactive', 'Pause before opening the PR and wait for approval from the TUI')
    .option(
      '--no-pr',
      'Stop after a clean CHECK: no SHIP, push, PR, or other GitHub write (size gate off); the worktree is kept',
    )
    .option('--approve-plan', 'Pause after PLAN freezes the spec and wait for approval before BUILD')
    .option('--no-sandbox', 'Disable the containment sandbox for agent runs (dangerous)')
    .option(
      '--draft-pr',
      'Stop SHIP at a draft PR: skip mark-ready and auto-merge, overriding run.pr.draft in the repo config',
    )
    .option('--no-draft-pr', 'Mark the PR ready for review after CI, overriding run.pr.draft in the repo config')
    .option('--branch-prefix <prefix>', BRANCH_PREFIX_OPTION_DESCRIPTION)
    .option(
      '--run-children',
      'File mode only: when the size gate files child issues, run them (slice mode never files issues)',
    )
    .option(
      '--size-gate <mode>',
      'Size gate mode for this run: file (file child issues / park), slice (ship as sequential slice PRs under the same issue; never files issues), off (skip both gates) or stack (stacked PR set, ADR-0161; runs as slice until stacks are built); beats sizeGate.mode in the config',
    )
    .option(
      '--max-slices <count>',
      'Slice mode: most slices a not-yet-started slice plan may have (1-20); an over-cap plan is recorded and parks; beats sizeGate.maxSlices (default 10)',
    )
    .action(async (issueNum, opts) => {
      await handlers.cmdRunIssue(handlers.parseIssueArg(issueNum), opts);
    });

  program
    .command('run-brief <file>')
    .description('Like run-issue, but the work comes from a local Markdown brief instead of a GitHub issue')
    .option('--product <name>', 'Override active product constitution')
    .option('--no-auto-rework', 'Disable automatic rework loop')
    .option('--interactive', 'Pause before opening the PR and wait for approval from the TUI')
    .option(
      '--no-pr',
      'Stop after a clean CHECK: no SHIP, push, PR, or other GitHub write (size gate off); the worktree is kept',
    )
    .option('--approve-plan', 'Pause after PLAN freezes the spec and wait for approval before BUILD')
    .option('--no-sandbox', 'Disable the containment sandbox for agent runs (dangerous)')
    .option(
      '--draft-pr',
      'Stop SHIP at a draft PR: skip mark-ready and auto-merge, overriding run.pr.draft in the repo config',
    )
    .option('--no-draft-pr', 'Mark the PR ready for review after CI, overriding run.pr.draft in the repo config')
    .option(
      '--workspace <dir>',
      'Local-only: run PLAN/BUILD/CHECK in this caller-provided git workspace and disable PR creation, merging, queue polling, and GitHub mutations',
    )
    .option(
      '--artifacts <dir>',
      'Local-only: write a versioned benchmark artifact manifest (manifest.json, request.json, events.ndjson, diff.patch) to this directory; requires --workspace',
    )
    .option('--branch-prefix <prefix>', BRANCH_PREFIX_OPTION_DESCRIPTION)
    .action(async (file, opts) => {
      await handlers.cmdRunBrief(file, opts);
    });

  program
    .command('land <issue>')
    .description(
      "Squash-merge the issue's open PR once CI is green, then remove its worktree (left open if CI fails or review is pending)",
    )
    .option('--branch-prefix <prefix>', BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION)
    .option(
      '--allow-gated',
      'Merge even when the issue or PR carries the no-auto-merge gate label (human override; writes an AUDIT line and a merge-gated-override event)',
    )
    .action(async (issueNum, opts) => {
      await handlers.cmdLand(handlers.parseIssueArg(issueNum), opts);
    });

  program
    .command('resume-approved')
    .description(
      `Land open factory PRs (factory/*, plus legacy ${LEGACY_BRANCH_PREFIX}/*) whose review is now approved; skip the rest`,
    )
    .option('--branch-prefix <prefix>', BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION)
    .action(async (opts) => {
      await handlers.cmdResumeApproved(opts);
    });

  program
    .command('run')
    .description(
      'Claim queued issues (factory:queued labels) and ship them, lanes in parallel; merges only when auto-merge is on',
    )
    .option('--local-queue', 'Read .factory/queue instead of claiming issues from GitHub Issues')
    .option('--auto-merge', 'Merge eligible PRs autonomously, overriding .factory/config.yaml and FACTORY_MERGE')
    .option('--no-auto-merge', 'Never merge autonomously, overriding .factory/config.yaml and FACTORY_MERGE')
    .option(
      '--pr-classifier',
      'Hold PRs whose review floor is B or C for a human (applies no-auto-merge), overriding the repo config (.factory/config.yaml) and FACTORY_PR_CLASSIFIER',
    )
    .option(
      '--no-pr-classifier',
      'Never run the PR classifier gate, overriding the repo config (.factory/config.yaml) and FACTORY_PR_CLASSIFIER',
    )
    .option(
      '--usage-watch',
      'Enforce the usage gate for this run, overriding .factory/config.yaml and FACTORY_USAGE_WATCH',
    )
    .option(
      '--no-usage-watch',
      'Skip the usage gate for this run, overriding .factory/config.yaml and FACTORY_USAGE_WATCH',
    )
    .option(
      '--usage-threshold <fraction>',
      "Override .factory/config.yaml and FACTORY_STOP_AT for this run's usage threshold",
    )
    .option('--usage-poll <seconds>', "Override .factory/config.yaml and FACTORY_USAGE_POLL for this run's usage poll")
    .option('--branch-prefix <prefix>', BRANCH_PREFIX_OPTION_DESCRIPTION)
    .action(
      (opts: {
        localQueue?: boolean;
        autoMerge?: boolean;
        usageWatch?: boolean;
        usageThreshold?: string;
        usagePoll?: string;
        branchPrefix?: string;
      }) => handlers.cmdRun(opts),
    );

  program
    .command('supervise')
    .description('Unattended loop: wait for usage headroom, run the queue, repeat until it is empty')
    .option('--now', 'Skip the initial headroom wait')
    .option('--local-queue', 'Read .factory/queue instead of claiming issues from GitHub Issues')
    .option('--auto-merge', 'Merge eligible PRs autonomously, overriding .factory/config.yaml and FACTORY_MERGE')
    .option('--no-auto-merge', 'Never merge autonomously, overriding .factory/config.yaml and FACTORY_MERGE')
    .option(
      '--usage-watch',
      'Enforce the usage gate for this run, overriding .factory/config.yaml and FACTORY_USAGE_WATCH',
    )
    .option(
      '--no-usage-watch',
      'Skip the usage gate for this run, overriding .factory/config.yaml and FACTORY_USAGE_WATCH',
    )
    .option(
      '--usage-threshold <fraction>',
      "Override .factory/config.yaml and FACTORY_RESUME_AT for this run's usage threshold",
    )
    .option('--usage-poll <seconds>', "Override .factory/config.yaml and FACTORY_USAGE_POLL for this run's usage poll")
    .option('--branch-prefix <prefix>', BRANCH_PREFIX_OPTION_DESCRIPTION)
    .action(async (opts) => {
      await handlers.cmdSupervise(opts);
    });

  program
    .command('stop')
    .description('Tell running lanes to halt after their current issue')
    .option('--json', 'Print one JSON object (schemaVersion 1): action, repo, stopFlag before/after')
    .action((opts: { json?: boolean }) => handlers.cmdStop(opts));

  program
    .command('resume [issue]')
    .description(
      'Clear a stop so lanes pick up new issues again; with <issue> --from check, re-run CHECK on a build kept after an environment failure',
    )
    .option('--json', 'Print one JSON object (schemaVersion 1): action, repo, stopFlag before/after')
    .option('--from <phase>', 'Resume a kept build at this phase (only: check)')
    .action((issue: string | undefined, opts: { json?: boolean; from?: string }) => handlers.cmdResume(issue, opts));

  program
    .command('steer <ref>')
    .description('Record a human or bot steer on the run for an issue or PR (appended to state/runs/issue-<n>.json)')
    .requiredOption('--message <text>', 'One-line summary of the steer')
    .option('--source <source>', 'Where the steer came from: cli, bot, github-comment', 'cli')
    .option('--phase <phase>', "Phase the steer applied to: plan, build, check, ship (default: from the run's status)")
    .option('--actor <id>', 'Who steered (default: git user.name, then $USER; required with --source bot)')
    .option('--unblocked', 'Mark that this steer unblocked a stuck run')
    .action((ref: string, opts: SteerOptions) => handlers.cmdSteer(ref, opts));
}
