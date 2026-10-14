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
    .action((opts: { force?: boolean }) => handlers.cmdInit(opts));

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
    .description('Check agent CLIs declared under harnesses: in .factory/config.yaml');
  harnessCmd
    .command('check <id>')
    .description('Run the harness contract kit against a declared harness; exit 0 only when every case passes')
    .option('--model <id>', 'Registry model to run (default: the first models.registry entry on that harness)')
    .option('--no-injection', 'Skip the prompt-injection cases (they call the real CLI and spend tokens)')
    .action((id: string, opts: { model?: string; injection?: boolean }) => handlers.cmdHarnessCheck(id, opts));

  program
    .command('doctor')
    .description(
      'Check your environment (git, agent install and sign-in, gh auth, GitHub token, npm, sandbox, .factory/)',
    )
    .option(
      '--reconcile',
      'Reap stale port leases, dead-run worktrees, stale issue claims, orphan sf-job-*/factory.managed containers, and orphan factory-* sbx VMs',
    )
    .option(
      '--probe-inference',
      'Also send one real prompt with claude -p on the host and in the sandbox to verify Claude auth (uses quota)',
    )
    .action((opts: { reconcile?: boolean; probeInference?: boolean }) => handlers.cmdDoctor(opts));
}
