// packages/cli/src/cli/light.ts — dependency-free program pieces: --help, bare `factory` and `--version` build from these without loading the engine (#3251)

import { createRequire } from 'node:module';
import { LEGACY_BRANCH_PREFIX } from '@on-par/factory-core/constants';

export const BRANCH_PREFIX_OPTION_DESCRIPTION =
  'Branch-name prefix for branches this command creates (default: factory)';
export const BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION = `Branch-name prefix of factory branches to act on; legacy ${LEGACY_BRANCH_PREFIX}/ branches are always included (default: factory)`;

export const DOCS_URL = 'https://github.com/on-par/software-factory#readme';

/** Printed by bare `factory` (no subcommand). */
export function formatOverview(): string {
  return `factory — ship verified GitHub issues autonomously

The software factory takes issues from your backlog through a
plan → build → check → ship pipeline using a boss-worker-checker
pattern, and opens a pull request for each one.

Common commands:
  factory init                     Initialize .factory/ in this repo
  factory ship <issue>             Plan → build → check one issue and open a PR
  factory queue add <lane> <N...>  Queue issues into a lane (GitHub labels)
  factory run                      Ship queued issues, lanes in parallel
  factory status                   Show active runs and the queue

Check your setup:       factory doctor
All commands:           factory --help
Docs:                   ${DOCS_URL}
`;
}

export const PREREQUISITES_TEXT = `First step: run \`factory doctor\` to check your setup and see what to fix.

Prerequisites:
  - Claude Code CLI installed and authenticated (Claude subscription): https://claude.com/claude-code
  - GitHub CLI authenticated: gh auth login
  - GITHUB_TOKEN or GH_TOKEN set (falls back to \`gh auth token\`)
Run inside a git repository with a GitHub remote.
`;

/** Printed after the command list in `factory --help`: the env vars operators reach for most. */
export const HELP_FOOTER_TEXT = `
Common environment variables:
  FACTORY_MERGE=1                     Squash-merge eligible PRs (--auto-merge / --no-auto-merge win)
  FACTORY_MERGE_ADMIN=1               Merge with GitHub admin bypass of unmet requirements
  FACTORY_SKIP_CI=1                   Do not wait for CI before merging
  FACTORY_SANDBOX=0                   Disable the containment sandbox for agent runs (dangerous)
  FACTORY_PLAN_MODEL=<id>             Pick the PLAN model
  FACTORY_BUILD_MODEL=<id>            Pick the BUILD model
  FACTORY_STOP_AT=<fraction>          Usage fraction (0-1] at which work pauses
  FACTORY_RESUME_AT=<fraction>        Usage fraction (0-1] at which paused work resumes
  FACTORY_ALLOW_STALE=1               Run even when the built CLI is older than its source
Every config key, its default, and its env var: docs/config.example.yaml

Run \`factory <command> --help\` for a command's options.
Docs: ${DOCS_URL}`;

/** Expected user-facing CLI failure. Thrown by command helpers; only main() maps it to a process exit code. */
export class CliExitError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'CliExitError';
  }
}

/** Parse a CLI <issue> argument; rejects unsafe integers (#2836), also used by reset. Throws CliExitError(2) before any git/GitHub work runs. */
export function parseIssueArg(raw: string): number {
  const n = /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new CliExitError(`factory: invalid issue argument '${raw}' — expected a positive integer issue number`, 2);
  }
  return n;
}

export function getCliVersion(): string {
  return createRequire(import.meta.url)('../../package.json').version;
}
