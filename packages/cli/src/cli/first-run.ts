// packages/cli/src/cli/first-run.ts — designed first-run copy: overview + structured error messages

export const DOCS_URL = 'https://github.com/on-par/software-factory#readme';
export const CLAUDE_CODE_URL = 'https://docs.anthropic.com/en/docs/claude-code';
export const GITHUB_TOKENS_URL = 'https://github.com/settings/tokens';

/** Printed by bare `factory` (no subcommand). */
export function formatOverview(): string {
  return `factory — ship verified GitHub issues autonomously

The software factory takes issues from your backlog through a
plan → build → check → ship pipeline using a boss-worker-checker
pattern, and opens a pull request for each one.

Common commands:
  factory init          Initialize .factory/ in this repo
  factory triage        Propose a work queue from open issues
  factory ship <issue>  Plan → build → check → ship one issue

Check your setup:       factory doctor
All commands:           factory --help
Docs:                   ${DOCS_URL}
`;
}

export function missingClaudeCliMessage(): string {
  return `claude CLI not found — install Claude Code first: ${CLAUDE_CODE_URL}`;
}

export function missingTokenMessage(): string {
  return `GITHUB_TOKEN not set — create a token at ${GITHUB_TOKENS_URL} and export it (or run \`gh auth login\`)`;
}

export function notInitializedMessage(): string {
  return 'factory not initialized — run `factory init` first';
}
