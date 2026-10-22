// packages/core/src/config/config-lint.ts — the one pre-PLAN config rule set shared by the run preflight and factory doctor (#2612).
import { readFileSync } from 'node:fs';
import { findUnknownConstitutionCheckers, formatUnknownCheckerMessage } from '../checkers/constitution-preflight.js';
import type { Constitution } from '../types/index.js';
import { preflightConfigTokens } from './template-tokens.js';

export { findUnknownConfigKeyWarnings } from './config-schema-lint.js';

export type ConfigLintVerdict = 'ok' | 'escalate' | 'park';

export interface ConfigLintFinding {
  rule: 'unknown-checker' | 'template-token';
  /** Display path, e.g. `.factory/constitution.md`. */
  file: string;
  /** 1-based line when known. */
  line?: number;
  /** The offending checker name or `<token>` text. */
  token: string;
  /** Exactly the message the run preflight prints for this finding. */
  message: string;
}

export interface ConfigLintInput {
  constitution: Constitution | null;
  configFile?: { absPath: string; relPath: string };
}

export interface ConfigLintResult {
  verdict: ConfigLintVerdict;
  findings: ConfigLintFinding[];
}

/** Apply the pre-PLAN config rules: unknown constitution checkers escalate (#2585), unfilled `<...>` template
 *  tokens park (#2586). Read-only; checker findings take precedence over token findings. */
export function lintFactoryConfig(input: ConfigLintInput): ConfigLintResult {
  const { constitution, configFile } = input;
  const checkerFindings: ConfigLintFinding[] = [];
  if (constitution?.checkers?.length) {
    const file =
      constitution.repoInstance?.absPath ?? (constitution.source === 'bundled' ? constitution.path : undefined);
    let raw: string | undefined;
    if (file) {
      try {
        raw = readFileSync(file, 'utf-8');
      } catch {
        raw = undefined;
      }
    }
    const display = constitution.repoInstance?.relPath ?? constitution.path;
    for (const p of findUnknownConstitutionCheckers(constitution.checkers, raw)) {
      checkerFindings.push({
        rule: 'unknown-checker',
        file: display,
        line: p.line,
        token: p.name,
        message: formatUnknownCheckerMessage(display, p),
      });
    }
  }

  // A `<checker-name>` line is already an unknown-checker finding; keep one finding per line.
  const tokenFindings: ConfigLintFinding[] = preflightConfigTokens({ constitution, configFile })
    .filter((f) => !checkerFindings.some((c) => c.file === f.file && c.line === f.line))
    .map((f) => ({ rule: 'template-token', file: f.file, line: f.line, token: f.token, message: f.message }));

  const verdict: ConfigLintVerdict = checkerFindings.length > 0 ? 'escalate' : tokenFindings.length > 0 ? 'park' : 'ok';
  return { verdict, findings: [...checkerFindings, ...tokenFindings] };
}
