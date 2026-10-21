// packages/cli/src/cli/risk.ts — `factory risk <pr>`: print a PR's risk tier and matched rules (#3385)

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseRiskRules, type RiskRuleSet } from '@on-par/factory-config';
import {
  evaluateRisk,
  listPrChangedFiles,
  loadRiskPolicy as loadRepoRiskPolicy,
  RISK_POLICY_FILE,
  type RiskEvaluation,
  type RiskPolicy,
} from '@on-par/factory-core/internal';

import type { CliExitError } from './index.js';

export class RiskCommandError extends Error {
  readonly code: number;
  constructor(message: string, code: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RiskCommandError';
    this.code = code;
  }
}

export interface RiskCommandDeps {
  /** owner/name of the repo the PR lives in; used in messages. */
  repo: string;
  listFiles: (pr: number) => Promise<string[]>;
  readFile: (path: string) => string;
  fileExists: (path: string) => boolean;
  /** The repo policy (`.factory/risk.yml`, else the packaged defaults) used when `--policy` is absent (#3387). */
  loadRepoPolicy: () => RiskPolicy;
  log: (line: string) => void;
}

/** Parse the <pr> argument (`42` or `#42`) into a positive safe integer; exit 2 otherwise. */
export function parsePrArg(raw: string): number {
  const trimmed = raw.trim();
  const digits = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  const n = Number(digits);
  if (!/^\d+$/.test(digits) || !Number.isSafeInteger(n) || n <= 0) {
    throw new RiskCommandError(`factory risk: invalid PR argument '${raw}' — expected a positive PR number`, 2);
  }
  return n;
}

export function loadRiskPolicy(
  path: string | undefined,
  deps: Pick<RiskCommandDeps, 'readFile' | 'fileExists' | 'loadRepoPolicy'>,
): { rules: RiskRuleSet; source: string } {
  if (path === undefined) {
    try {
      const policy = deps.loadRepoPolicy();
      return { rules: policy.rules, source: policy.source === 'repo' ? RISK_POLICY_FILE : 'packaged defaults' };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new RiskCommandError(`factory risk: invalid risk policy ${RISK_POLICY_FILE} — ${detail}`, 2, {
        cause: err,
      });
    }
  }
  if (!deps.fileExists(path)) {
    throw new RiskCommandError(`factory risk: risk policy file not found: ${path}`, 2);
  }
  try {
    const rules = parseRiskRules(JSON.parse(deps.readFile(path)));
    return { rules, source: path };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RiskCommandError(`factory risk: invalid risk policy ${path} — ${detail}`, 2, { cause: err });
  }
}

export function formatRiskReport(pr: number, evaluation: RiskEvaluation, policySource: string): string[] {
  const lines = [`PR #${pr}: tier ${evaluation.tier}`, `Policy: ${policySource}`, 'Matched rules:'];
  for (const rule of evaluation.rules) {
    const paths = rule.paths.length > 0 ? rule.paths.join(', ') : '(no changed files)';
    lines.push(`  - ${rule.id} (${rule.tier}): ${paths}`);
  }
  return lines;
}

export async function runRiskCommand(
  prArg: string,
  opts: { policy?: string },
  deps: RiskCommandDeps,
): Promise<RiskEvaluation> {
  const pr = parsePrArg(prArg);
  const policy = loadRiskPolicy(opts.policy, deps);
  let paths: string[];
  try {
    paths = await deps.listFiles(pr);
  } catch (err) {
    if ((err as { status?: number } | null)?.status === 404) {
      throw new RiskCommandError(`factory risk: PR #${pr} not found in ${deps.repo}`, 1);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new RiskCommandError(`factory risk: could not list files for PR #${pr} — ${detail}`, 1);
  }
  const evaluation = evaluateRisk({ paths, rules: policy.rules });
  for (const line of formatRiskReport(pr, evaluation, policy.source)) deps.log(line);
  return evaluation;
}

/** What `factory risk` needs from the CLI entry point; index.ts binds it (#3385). */
export interface RiskRuntime {
  getRepoRoot: () => Promise<string>;
  getGitHubRepo: () => Promise<string>;
  getOctokit: () => Parameters<typeof listPrChangedFiles>[0];
  CliExitError: typeof CliExitError;
  log: (line: string) => void;
}

/** Wire the real filesystem and GitHub reads for `runRiskCommand`. */
export function riskCommandDeps(
  repoRoot: string,
  slug: string,
  rt: Pick<RiskRuntime, 'getOctokit' | 'log'>,
): RiskCommandDeps {
  const [owner = '', repo = ''] = slug.split('/');
  return {
    repo: slug,
    listFiles: (n) => listPrChangedFiles(rt.getOctokit(), owner, repo, n),
    readFile: (p) => readFileSync(resolve(repoRoot, p), 'utf-8'),
    fileExists: (p) => existsSync(resolve(repoRoot, p)),
    loadRepoPolicy: () => loadRepoRiskPolicy(repoRoot),
    log: rt.log,
  };
}

/** `factory risk <pr>`: a RiskCommandError becomes a CliExitError carrying its exit code. */
export async function cmdRisk(pr: string, opts: { policy?: string }, rt: RiskRuntime): Promise<void> {
  try {
    parsePrArg(pr); // a bad <pr> exits 2 before any git or GitHub lookup
    const deps = riskCommandDeps(await rt.getRepoRoot(), await rt.getGitHubRepo(), rt);
    await runRiskCommand(pr, opts, deps);
  } catch (err) {
    if (err instanceof RiskCommandError) throw new rt.CliExitError(err.message, err.code);
    throw err;
  }
}
