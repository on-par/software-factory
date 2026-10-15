// packages/cli/src/cli/first-run.ts — designed first-run copy: overview + structured error messages

import { openCodeVersion } from '@on-par/factory-core/internal';

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

export const CODEX_CLI_URL = 'https://developers.openai.com/codex/cli';
export const OPENCODE_URL = 'https://opencode.ai';

/** Coding agent CLIs the factory can drive for PLAN and BUILD. Any one of them is enough. */
export const AGENT_CLIS = ['claude', 'codex', 'opencode'] as const;

/** Agent CLIs from AGENT_CLIS found on PATH. */
export function availableAgentClis(commandAvailable: (cmd: string) => boolean): string[] {
  return AGENT_CLIS.filter((cmd) => commandAvailable(cmd));
}

export function missingAgentCliMessage(): string {
  return `no coding agent CLI found on PATH (claude, codex or opencode). Install one: Claude Code (${CLAUDE_CODE_URL}), the Codex CLI (${CODEX_CLI_URL}) or OpenCode (${OPENCODE_URL}; \`${openCodeVersion.OPENCODE_PINNED_INSTALL}\`), then sign in with \`claude /login\`, \`codex login\` or \`opencode auth login\`. OpenCode models are experimental: set FACTORY_EXPERIMENTAL=1 to use them`;
}

export function missingTokenMessage(): string {
  return `GITHUB_TOKEN not set — create a token at ${GITHUB_TOKENS_URL} and export it (or run \`gh auth login\`)`;
}

export function notInitializedMessage(): string {
  return 'factory not initialized — run `factory init` first';
}
