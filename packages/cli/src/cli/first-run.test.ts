import { describe, expect, it } from 'vitest';

import {
  DOCS_URL,
  formatOverview,
  missingClaudeCliMessage,
  missingTokenMessage,
  notInitializedMessage,
} from './first-run.js';

describe('formatOverview', () => {
  it('matches the frozen copy', () => {
    expect(formatOverview()).toMatchInlineSnapshot(`
      "factory — ship verified GitHub issues autonomously

      The software factory takes issues from your backlog through a
      plan → build → check → ship pipeline using a boss-worker-checker
      pattern, and opens a pull request for each one.

      Common commands:
        factory init          Initialize .factory/ in this repo
        factory triage        Propose a work queue from open issues
        factory ship <issue>  Plan → build → check → ship one issue

      Check your setup:       factory doctor
      All commands:           factory --help
      Docs:                   https://github.com/on-par/software-factory#readme
      "
    `);
  });

  it('contains the common-command hints and docs URL', () => {
    const overview = formatOverview();
    expect(overview).toContain('factory init');
    expect(overview).toContain('factory triage');
    expect(overview).toContain('factory ship <issue>');
    expect(overview).toContain('factory doctor');
    expect(overview).toContain(DOCS_URL);
  });

  it('never leaks a stack trace or internal paths', () => {
    const overview = formatOverview();
    expect(overview).not.toContain('Error');
    expect(overview).not.toContain('at ');
    expect(overview).not.toContain('node_modules');
  });
});

describe('missingClaudeCliMessage', () => {
  it('matches the frozen copy', () => {
    expect(missingClaudeCliMessage()).toMatchInlineSnapshot(
      `"claude CLI not found — install Claude Code first: https://docs.anthropic.com/en/docs/claude-code"`,
    );
  });

  it('contains the acceptance-criteria substring verbatim', () => {
    expect(missingClaudeCliMessage()).toContain('claude CLI not found — install Claude Code first:');
  });
});

describe('missingTokenMessage', () => {
  it('matches the frozen copy', () => {
    expect(missingTokenMessage()).toMatchInlineSnapshot(
      `"GITHUB_TOKEN not set — create a token at https://github.com/settings/tokens and export it (or run \`gh auth login\`)"`,
    );
  });

  it('contains the acceptance-criteria substring verbatim', () => {
    expect(missingTokenMessage()).toContain(
      'GITHUB_TOKEN not set — create a token at https://github.com/settings/tokens and export it',
    );
  });
});

describe('notInitializedMessage', () => {
  it('matches the frozen copy', () => {
    expect(notInitializedMessage()).toMatchInlineSnapshot(`"factory not initialized — run \`factory init\` first"`);
  });

  it('contains the acceptance-criteria substring verbatim', () => {
    expect(notInitializedMessage()).toContain('factory not initialized — run `factory init` first');
  });
});
