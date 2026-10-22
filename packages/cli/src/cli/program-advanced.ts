// packages/cli/src/cli/program-advanced.ts — registers the Advanced / experimental help-group commands (#2793)

import type { Command } from 'commander';
import { DEFAULT_FACTORYD_PORT } from '@on-par/factory-core/internal';
import { AgentJobUsageError, cmdAgentJob } from './agent-job.js';
import { BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION } from './branch-prefix.js';
import { DaemonCtlError } from './daemon.js';
import type { CliDeps, ProgramHandlers } from './index.js';
import { cmdSelfUpdateApply } from './self-update-apply.js';

export function registerAdvancedCommands(program: Command, handlers: ProgramHandlers, deps: CliDeps): void {
  const hosted = program
    .command('hosted')
    .description('Experimental remote-runner execution (needs FACTORY_HOSTED_EXEC=1)');
  hosted
    .command('smoke')
    .description('Local end-to-end hosted-exec smoke: create → lease → Docker run → result → cleanup')
    .option('--repo <slug>', 'owner/repo to clone and run against', 'on-par/software-factory')
    .option('--image <image>', 'Container image for the smoke run', 'node:20-alpine')
    .action(async (opts: { repo?: string; image?: string }) => {
      await handlers.cmdHostedSmoke(opts);
    });
  hosted
    .command('runner')
    .description('Register capabilities with the local control plane and lease one compatible job, then exit')
    .option('--url <url>', 'Control-plane base URL', 'http://127.0.0.1:8799')
    .option('--runner-id <id>', 'Runner identity (default runner-<pid>)')
    .option('--capabilities <csv>', 'Comma-separated capability list', 'git,node')
    .option('--timeout <ms>', 'Bounded wait window for a compatible job, in ms', '30000')
    .option('--poll-interval <ms>', 'Delay between poll attempts, in ms', '2000')
    .option('--lease-ttl <ms>', 'Lease TTL, in ms', '300000')
    .option('--heartbeat-interval <ms>', 'Expected heartbeat interval, in ms', '30000')
    .action(
      async (opts: {
        url?: string;
        runnerId?: string;
        capabilities?: string;
        timeout?: string;
        pollInterval?: string;
        leaseTtl?: string;
        heartbeatInterval?: string;
      }) => {
        await handlers.cmdHostedRunner(opts);
      },
    );
  hosted
    .command('queue')
    .description('Queue one job to the local control plane, tail it to terminal, print the result')
    .option('--url <url>', 'Control-plane base URL', 'http://127.0.0.1:8799')
    .option('--repo <slug>', 'owner/repo the job runs against', 'on-par/software-factory')
    .option('--task <text>', 'Opaque task payload')
    .option('--capabilities <csv>', 'Comma-separated required capabilities', 'git,node')
    .option('--authority <authority>', 'Required authority', 'repo:read')
    .option('--timeout <ms>', 'Bounded wait for a terminal result, in ms', '120000')
    .option('--poll-interval <ms>', 'Delay between summary polls, in ms', '1000')
    .option('--job-id <id>', 'Explicit job id (default server-generated)')
    .action(
      async (opts: {
        url?: string;
        repo?: string;
        task?: string;
        capabilities?: string;
        authority?: string;
        timeout?: string;
        pollInterval?: string;
        jobId?: string;
      }) => {
        await handlers.cmdHostedQueue(opts);
      },
    );

  program
    .command('local-small-dry-run <issue>')
    .description('Create a bounded local-small step plan and first context pack without changing source files')
    .option('--spec <path>', 'Frozen spec path; defaults to .factory/plans/issue-<n>.md')
    .option('--output <path>', 'Artifact directory; defaults to .factory/local-small/issue-<n>')
    .action(async (issueNum, opts) => {
      await handlers.cmdLocalSmallDryRun(handlers.parseIssueArg(issueNum), opts);
    });

  program
    .command('local-small-overnight')
    .description(
      'Process a curated local-small queue one issue at a time: review-only PRs, never merges, parks on ambiguity',
    )
    .option('--queue <path>', 'Curated queue file; defaults to .factory/local-small/overnight-queue')
    .option('--state <path>', 'Resume-state file; defaults to .factory/local-small/overnight-state.json')
    .action(async (opts) => {
      await handlers.cmdLocalSmallOvernight(opts);
    });

  program
    .command('proxy')
    .description('Run the opt-in lane reverse proxy in the foreground (run and supervise start it themselves)')
    .action(handlers.cmdProxy);

  const daemonCmd = program
    .command('daemon')
    .description('Manage factoryd, the long-running background service for this user');
  daemonCmd
    .command('run')
    .description('Run factoryd in the foreground: a localhost-only HTTP API over the repo registry')
    .option('--port <n>', `Port to bind on 127.0.0.1 (default ${DEFAULT_FACTORYD_PORT})`)
    .option('--registry <file>', 'Registry file to serve (default ~/.factory/registry.json)')
    .option(
      '--update-mode <mode>',
      'Self-update channel: manual, stable (npm latest) or prerelease (npm next) (default: stable on npm installs, manual otherwise)',
    )
    .option('--auto-update', 'Deprecated: same as --update-mode stable')
    .action((opts: { port?: string; registry?: string; updateMode?: string; autoUpdate?: boolean }) =>
      handlers.cmdFactoryd(opts),
    );
  const daemonCtl = <T>(fn: () => Promise<T>) =>
    fn().catch((err: unknown) => {
      if (err instanceof DaemonCtlError) throw new handlers.CliExitError(err.message, err.code);
      throw err;
    });
  daemonCmd
    .command('start')
    .description('Install and load the com.onpar.factoryd LaunchAgent (macOS only; KeepAlive, RunAtLoad)')
    .action(() => daemonCtl(() => handlers.cmdDaemonStart(deps.daemon)));
  daemonCmd
    .command('stop')
    .description('Unload the LaunchAgent (macOS only; plist stays installed)')
    .action(() => daemonCtl(() => handlers.cmdDaemonStop(deps.daemon)));
  daemonCmd
    .command('status')
    .description('Report factoryd pid, uptime, and attached repos')
    .option('--json', 'Print one JSON object (schemaVersion 1) instead of text')
    .action((opts: { json?: boolean }) => daemonCtl(() => handlers.cmdDaemonStatus(deps.daemon, { json: opts.json })));
  daemonCmd
    .command('logs')
    .description('Print or tail ~/.factory/daemon.log')
    .option('-f, --follow', 'Keep tailing')
    .option('-n, --lines <n>', 'Lines to print first (default 100)')
    .action((opts: { follow?: boolean; lines?: string }) => daemonCtl(() => handlers.cmdDaemonLogs(opts, deps.daemon)));

  program
    .command('self-update')
    .description('Check npm for a newer factory release (--check), or install an exact stable release (--to)')
    .option('--check', 'Compare the running version with the npm dist-tag (read-only)')
    .option(
      '--to <version>',
      'Install this exact stable version next to the running Node, run doctor, restart; roll back on failure',
    )
    .option('--dry-run', 'With --to: validate the version, install kind, and npm without installing')
    .option('--force', 'With --to: apply even while a run is active')
    .option('--no-restart', 'With --to: do not restart factoryd (factoryd passes this and restarts itself)')
    .option('--json', 'Print one JSON object instead of text')
    .option('--update-mode <mode>', 'Channel to check: stable (npm latest, default) or prerelease (npm next)')
    .action(
      async (opts: {
        check?: boolean;
        to?: string;
        dryRun?: boolean;
        force?: boolean;
        restart?: boolean;
        json?: boolean;
        updateMode?: string;
      }) => {
        if (opts.check === true && opts.to !== undefined) {
          throw new handlers.CliExitError('factory self-update: --check and --to are mutually exclusive', 2);
        }
        if (opts.to !== undefined) {
          const to = opts.to;
          process.exitCode = await daemonCtl(() =>
            cmdSelfUpdateApply(
              { to, json: opts.json, dryRun: opts.dryRun, force: opts.force, restart: opts.restart },
              deps.selfUpdate,
            ),
          );
          return;
        }
        if (opts.check !== true)
          throw new handlers.CliExitError('factory self-update: pass --check or --to <version>', 2);
        process.exitCode = await daemonCtl(() => handlers.cmdSelfUpdateCheck(opts, deps.selfUpdate));
      },
    );

  const worktreeCmd = program
    .command('worktree')
    .description('Clean up stale factory worktrees (gc) and keep/release one for manual work');
  worktreeCmd
    .command('gc')
    .description('Remove stale factory worktrees (merged/closed branches or older than TTL) and scrub credentials')
    .option('--dry-run', 'Preview what would be removed without deleting anything')
    .option('--ttl-days <n>', 'Override worktree.gcTtlDays from .factory/config.yaml (default 7)')
    .option('--branch-prefix <prefix>', BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION)
    .action(handlers.cmdWorktreeGc);
  worktreeCmd
    .command('keep <issue>')
    .description(
      "Protect an issue's lane worktree from worktree GC while you finish it by hand (until the issue closes or you release it)",
    )
    .option('--reason <text>', 'Why it is kept, shown by worktree gc (default: manual)')
    .option('--branch-prefix <prefix>', BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION)
    .action(handlers.cmdWorktreeKeep);
  worktreeCmd
    .command('release <issue>')
    .description("Drop an issue's keep record so the next worktree GC treats its worktree normally")
    .action(handlers.cmdWorktreeRelease);

  program
    .command('reset <issue...>')
    .description(
      "Remove an issue's local factory state (worktree, local branch, plan/phase files, rework history, logs, leases) so the next run starts fresh. A worktree or branch with uncommitted changes or unpushed commits is kept unless --force is passed. Do not run while that issue's lane is active. Preview with --dry-run",
    )
    .option(
      '--dry-run',
      'List every worktree, branch, file, history entry, log dir, claim and lease that would be removed, without changing anything',
    )
    .option('--force', 'Remove worktrees and branches even when they have uncommitted changes or unpushed commits')
    .option('--branch-prefix <prefix>', BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION)
    .action(handlers.cmdReset);

  program
    .command('agent-job')
    .description(
      'Run an ad-hoc rescue or steward command while holding a host agent job lease (host.maxAgentJobs, default 1); waits for a free lease and releases it when the command ends',
    )
    .argument('<command...>', 'Command and arguments to run, after --')
    .option('--kind <kind>', 'rescue or steward', 'rescue')
    .option('--repo <slug>', 'owner/repo recorded on the lease')
    .option('--issue <n>', 'Issue number recorded on the lease')
    .action(async (command: string[], opts: { kind?: string; repo?: string; issue?: string }) => {
      try {
        process.exitCode = await cmdAgentJob(command, opts);
      } catch (err) {
        if (!(err instanceof AgentJobUsageError)) throw err;
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 2;
      }
    });
}
