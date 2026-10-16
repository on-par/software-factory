// src/phases/build-lint-rules.ts — "Lint rules in force" BUILD prompt section from .oxlintrc.json (#3040)

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { detectLintConfig } from '../checkers/probe.js';
import { UNTRUSTED_LINT_CONFIG_NOTICE, wrapUntrustedLintConfig } from '../utils/untrusted-input.js';

export const LINT_RULES_HEADING = '## Lint rules in force';

// oxlint AllowWarnDeny: "error" | "deny" | 2 are error severity.
const ERROR_SEVERITIES = new Set<unknown>(['error', 'deny', 2]);
const SAFE_RULE_NAME = /^[A-Za-z0-9@_./-]{1,200}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Top-level error-severity rule names from a parsed oxlint config; unsafe names are dropped and counted. */
export function collectOxlintErrorRules(config: unknown): { rules: string[]; unsafe: number } {
  if (!isPlainObject(config) || !isPlainObject(config.rules)) return { rules: [], unsafe: 0 };
  const rules: string[] = [];
  let unsafe = 0;
  for (const [name, value] of Object.entries(config.rules)) {
    const head = Array.isArray(value) ? value[0] : value;
    const severity = typeof head === 'string' ? head.toLowerCase() : head;
    if (!ERROR_SEVERITIES.has(severity)) continue;
    if (SAFE_RULE_NAME.test(name)) rules.push(name);
    else unsafe++;
  }
  return { rules: rules.sort(), unsafe };
}

/** Markdown section (leading blank line) for the BUILD prompt, or '' when there is nothing to say. Never throws. */
export async function renderLintRulesInForce(worktree: string): Promise<string> {
  try {
    const probe = await detectLintConfig(worktree);
    if (!probe || probe.linter !== 'oxlint' || probe.format !== 'json') return '';

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(worktree, probe.configPath), 'utf-8'));
    } catch {
      parsed = undefined;
    }
    if (!isPlainObject(parsed)) {
      return `\n\n${LINT_RULES_HEADING}\nThe repo configures oxlint in \`${probe.configPath}\`, but it could not be parsed as JSON, so its rules are not listed here. Run the repo's lint command to see them.`;
    }

    const { rules, unsafe } = collectOxlintErrorRules(parsed);
    if (rules.length === 0 && unsafe === 0) return '';

    const list = wrapUntrustedLintConfig(rules.map((r) => `- ${r}`).join('\n'));
    const omitted = unsafe > 0 ? `\n${unsafe} rule name(s) omitted (unsafe characters).` : '';
    return (
      `\n\n${LINT_RULES_HEADING}\n` +
      `oxlint (\`${probe.configPath}\`) reports these rules as errors, and CHECK's lint step fails on them. Write code that satisfies them:\n` +
      `${UNTRUSTED_LINT_CONFIG_NOTICE}\n${list}${omitted}`
    );
  } catch {
    return '';
  }
}
