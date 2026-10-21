// src/phases/build-lint-rules.ts — "Lint rules in force" BUILD prompt section from .oxlintrc.json (#3040) or oxlint.config.* read as text, never evaluated (#3042); ESLint/Biome get a config pointer (#3041)

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { LintConfigProbe } from '../checkers/probe.js';
import { detectLintConfig } from '../checkers/probe.js';
import { UNTRUSTED_LINT_CONFIG_NOTICE, wrapUntrustedLintConfig } from '../utils/untrusted-input.js';

export const LINT_RULES_HEADING = '## Lint rules in force';

// Max rules listed in the prompt; the rest are counted, not named (#3042).
export const LINT_RULES_CAP = 40;

const LINTER_NAMES: Record<LintConfigProbe['linter'], string> = { oxlint: 'oxlint', eslint: 'ESLint', biome: 'Biome' };

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

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(^|[^:'"\\])\/\/.*$/gm;
const ERROR_PAIR =
  /(?:(['"`])([^'"`\n]{1,300})\1|([A-Za-z_$][\w$-]*))\s*:\s*\[?\s*(?:(['"`])(?:error|deny)\4|2(?![\w.]))/gi;

/** Error-severity rule keys scraped from oxlint.config.* source text (regex, no evaluation); unsafe names are dropped and counted. */
export function extractOxlintErrorRulesFromText(source: string): { rules: string[]; unsafe: number } {
  const stripped = source.replace(BLOCK_COMMENT, '').replace(LINE_COMMENT, '$1');
  const names = new Set<string>();
  for (const match of stripped.matchAll(ERROR_PAIR)) names.add(match[2] ?? match[3]);
  const rules: string[] = [];
  let unsafe = 0;
  for (const name of names) {
    if (SAFE_RULE_NAME.test(name)) rules.push(name);
    else unsafe++;
  }
  return { rules: rules.sort(), unsafe };
}

/** Pointer section naming the linter and its config path; never reads the config (#3041). */
export function renderLintConfigPointer(probe: LintConfigProbe): string {
  const exec = probe.executable ? ' It is a JS/TS module, so it was not evaluated.' : '';
  return (
    `\n\n${LINT_RULES_HEADING}\n` +
    `The repo lints with ${LINTER_NAMES[probe.linter]}, configured in \`${probe.configPath}\`. Read that file before you write any code, and write code that satisfies its rules: CHECK's lint step fails on its errors. Its rules are not listed here.${exec}`
  );
}

/** Markdown section (leading blank line) for the BUILD prompt, or '' when there is nothing to say. Never throws. */
export async function renderLintRulesInForce(worktree: string): Promise<string> {
  try {
    const probe = await detectLintConfig(worktree);
    if (!probe) return '';
    if (probe.linter === 'eslint' || probe.linter === 'biome') return renderLintConfigPointer(probe);

    let found: { rules: string[]; unsafe: number };
    if (probe.format === 'executable') {
      found = extractOxlintErrorRulesFromText(await readFile(join(worktree, probe.configPath), 'utf-8'));
    } else if (probe.format === 'json') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(join(worktree, probe.configPath), 'utf-8'));
      } catch {
        parsed = undefined;
      }
      if (!isPlainObject(parsed)) {
        return `\n\n${LINT_RULES_HEADING}\nThe repo configures oxlint in \`${probe.configPath}\`, but it could not be parsed as JSON, so its rules are not listed here. Run the repo's lint command to see them.`;
      }
      found = collectOxlintErrorRules(parsed);
    } else {
      return '';
    }
    const { rules, unsafe } = found;
    if (rules.length === 0 && unsafe === 0) return '';

    const shown = rules.slice(0, LINT_RULES_CAP);
    const leftOut = rules.length - shown.length;
    const list = wrapUntrustedLintConfig(shown.map((r) => `- ${r}`).join('\n'));
    const omitted = unsafe > 0 ? `\n${unsafe} rule name(s) omitted (unsafe characters).` : '';
    const capped = leftOut > 0 ? `\n${leftOut} more rule(s) left out (list capped at ${LINT_RULES_CAP}).` : '';
    return (
      `\n\n${LINT_RULES_HEADING}\n` +
      `oxlint (\`${probe.configPath}\`) reports these rules as errors, and CHECK's lint step fails on them. Write code that satisfies them:\n` +
      `${UNTRUSTED_LINT_CONFIG_NOTICE}\n${list}${omitted}${capped}`
    );
  } catch {
    return '';
  }
}

// BUILD workers read the code before editing instead of writing from the plan alone (#3372, T13).
export const READ_BEFORE_EDIT_RULE =
  'Before editing, open the files the spec and its design grounding name, read the code you will change and its direct callers, and reuse the helpers and conventions already there; the spec stays the plan, but do not write from it alone.';
