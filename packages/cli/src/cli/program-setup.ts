// packages/cli/src/cli/program-setup.ts — registers the Setup help-group commands (#2793)

import type { Command } from 'commander';
import type { ProgramHandlers } from './index.js';

export function registerSetupCommands(program: Command, handlers: ProgramHandlers): void {
  program
    .command('init')
    .description(
      'Set up .factory/ in this repo (config, constitution, queue file, .gitignore) and check model reachability',
    )
    .option('--force', 'Overwrite an existing .factory config, constitution, and .gitignore')
    .option('-y, --yes', 'Accept defaults without prompting (init never prompts; accepted for scripts and CI)')
    .action((opts: { force?: boolean; yes?: boolean }) => handlers.cmdInit(opts));

  program
    .command('migrate')
    .description(
      'Upgrade .factory/ to the v2 layout (config, constitution.md, .gitignore, state/); --to-yaml converts config.json to config.yaml',
    )
    .option('--dry-run', 'Print planned changes without writing')
    .option(
      '--to-yaml',
      'Convert .factory/config.json to .factory/config.yaml (removes the JSON only after a round-trip check)',
    )
    .action((opts: { dryRun?: boolean; toYaml?: boolean }) => handlers.cmdMigrate(opts));

  program
    .command('constitution')
    .description('Manage product constitutions — .factory/constitution.md in this repo is the source of truth')
    .option(
      '--init [product]',
      'Write .factory/constitution.md in this repo, scaffolded from the template (an optional name overrides the display name)',
    )
    .option('--list', 'List available constitutions with their checkers')
    .option('--checkers', 'List every built-in checker name with a one-line description')
    .option(
      '--product <name>',
      'Seed .factory/constitution.md from the bundled constitution for <name>; replaces an unmodified scaffold without --force',
    )
    .option('--force', 'With --init or --product, overwrite an existing .factory/constitution.md')
    .action((opts) => handlers.cmdConstitution(opts));

  program
    .command('models')
    .description('List models with their tiers, cost per 1M tokens, and availability')
    .option('--doctor', 'Probe provider CLIs and env keys; report per-model reachability')
    .action(handlers.cmdModels);

  const harnessCmd = program
    .command('harness')
    .description('Check a harness declared under harnesses: in .factory/config');
  harnessCmd
    .command('check <id>')
    .description(
      'Run the harness contract kit against a declared harness; exits 0 only when every case passes (spends model tokens)',
    )
    .option('--model <id>', 'Registry model id to run (default: the first models.registry entry on that harness)')
    .action((id: string, opts: { model?: string }) => handlers.cmdHarnessCheck(id, opts));

  program
    .command('doctor')
    .description(
      'Check your environment (git, agent install and sign-in, gh auth, GitHub token, npm, sandbox, .factory/, and the build/test/lint commands CHECK will run)',
    )
    .option(
      '--reconcile',
      'Reap stale port leases, dead-run worktrees, stale issue claims, orphan sf-job-*/factory.managed containers, and orphan factory-* sbx VMs',
    )
    .option(
      '--probe-inference',
      'Also send one real prompt with claude -p (host and sandbox) and opencode run to verify Claude and OpenCode auth (uses quota)',
    )
    .option('--json', 'Print the checks and the build/test/lint commands CHECK will run as JSON')
    .action((opts: { reconcile?: boolean; probeInference?: boolean; json?: boolean }) => handlers.cmdDoctor(opts));
}
