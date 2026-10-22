// packages/cli/src/cli/first-run.ts — designed first-run copy: overview + structured error messages

import { openCodeVersion } from '@on-par/factory-core/internal';

export { DOCS_URL, formatOverview } from './light.js';

export const CLAUDE_CODE_URL = 'https://docs.anthropic.com/en/docs/claude-code';
export const GITHUB_TOKENS_URL = 'https://github.com/settings/tokens';

export const CODEX_CLI_URL = 'https://developers.openai.com/codex/cli';
export const OPENCODE_URL = 'https://opencode.ai';
export const PI_INSTALL = 'npm install -g @earendil-works/pi-coding-agent';

/** Coding agent CLIs the factory can drive for PLAN and BUILD. Any one of them is enough. */
export const AGENT_CLIS = ['claude', 'codex', 'opencode', 'pi'] as const;

/** Agent CLIs from AGENT_CLIS found on PATH. */
export function availableAgentClis(commandAvailable: (cmd: string) => boolean): string[] {
  return AGENT_CLIS.filter((cmd) => commandAvailable(cmd));
}

export function missingAgentCliMessage(): string {
  return `no coding agent CLI found on PATH (claude, codex, opencode or pi). Install one: Claude Code (${CLAUDE_CODE_URL}), the Codex CLI (${CODEX_CLI_URL}) or OpenCode (${OPENCODE_URL}; \`${openCodeVersion.OPENCODE_PINNED_INSTALL}\`) or Pi (\`${PI_INSTALL}\`), then sign in with \`claude /login\`, \`codex login\`, \`opencode auth login\` or \`pi\` then \`/login <provider>\`. OpenCode models are experimental: set FACTORY_EXPERIMENTAL=1 to use them`;
}

export function missingTokenMessage(): string {
  return `GITHUB_TOKEN not set — create a token at ${GITHUB_TOKENS_URL} and export it (or run \`gh auth login\`)`;
}

export function notInitializedMessage(): string {
  return 'factory not initialized — run `factory init` first';
}
