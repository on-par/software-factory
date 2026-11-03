// src/checkers/preview-check.ts — SHIP preview gate: find the PR's preview, wait for it, run the repo's smoke command (#3880).
// Read-only against GitHub: it never deploys or provisions anything.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';

import type { PreviewConfig } from '../config/preview-section.js';
import type { CommandResult, RunCommandOptions } from '../utils/command-runner.js';
import { stripAnsi } from './command-log.js';
import { runVerificationCommand } from './run-command.js';

export type PreviewCheckStatus = 'pass' | 'fail' | 'preview-unavailable';

export interface PreviewCheckEvidence {
  url?: string;
  headSha: string;
  command: string[];
  exitCode?: number;
  durationMs: number;
  outputTail?: string;
  artifacts: string[];
  reason?: string;
  evidencePath?: string;
}

export interface PreviewCheckResult {
  status: PreviewCheckStatus;
  evidence: PreviewCheckEvidence;
}

export interface PreviewCheckInput {
  config: PreviewConfig;
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  worktree: string;
  env?: Record<string, string>;
  logsDir?: string;
  onPgid?: (pgid: number) => void;
}

type PreviewTarget = { owner: string; repo: string; prNumber: number; headSha: string };

export interface PreviewCheckDeps {
  findUrl: (octokit: Octokit, target: PreviewTarget, source: PreviewConfig['source']) => Promise<string | null>;
  probe: (url: string) => Promise<number | null>;
  runCommand: (argv: readonly string[], options: RunCommandOptions) => Promise<CommandResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const POLL_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 5000;
const TAIL_CHARS = 2000;
const SUMMARY_TAIL_CHARS = 1500;
const EVIDENCE_FILE = 'preview-check.json';

const defaultProbe: PreviewCheckDeps['probe'] = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' });
    return res.status;
  } catch {
    return null;
  }
};

const isHttpUrl = (value: string | null | undefined): value is string => {
  if (!value) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

const globToRegExp = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );

const describeSource = (source: PreviewConfig['source']): string =>
  source.kind === 'deployment' ? `deployment environment ${source.environment}` : `PR comment ${source.urlPattern}`;

async function findDeploymentUrl(octokit: Octokit, target: PreviewTarget, environment: string): Promise<string | null> {
  const matches = globToRegExp(environment);
  const { data } = await octokit.rest.repos.listDeployments({
    owner: target.owner,
    repo: target.repo,
    sha: target.headSha,
    per_page: 100,
  });
  const deployments = data
    .filter((d) => matches.test(d.environment))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const deployment of deployments) {
    const { data: statuses } = await octokit.rest.repos.listDeploymentStatuses({
      owner: target.owner,
      repo: target.repo,
      deployment_id: deployment.id,
      per_page: 100,
    });
    const newest = [...statuses].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (newest?.state !== 'success') continue;
    const url = newest.environment_url || newest.target_url;
    if (isHttpUrl(url)) return url;
  }
  return null;
}

async function findCommentUrl(octokit: Octokit, target: PreviewTarget, urlPattern: string): Promise<string | null> {
  const re = new RegExp(urlPattern);
  const { data } = await octokit.rest.issues.listComments({
    owner: target.owner,
    repo: target.repo,
    issue_number: target.prNumber,
    per_page: 100,
  });
  for (const comment of [...data].reverse()) {
    const m = re.exec(comment.body ?? '');
    const url = m?.groups?.url ?? m?.[1];
    if (isHttpUrl(url)) return url;
  }
  return null;
}

/** The preview URL for the PR head, or null when none is published yet. Read endpoints only. */
export async function findPreviewUrl(
  octokit: Octokit,
  target: { owner: string; repo: string; prNumber: number; headSha: string },
  source: PreviewConfig['source'],
): Promise<string | null> {
  return source.kind === 'deployment'
    ? findDeploymentUrl(octokit, target, source.environment)
    : findCommentUrl(octokit, target, source.urlPattern);
}

const DEFAULT_DEPS: PreviewCheckDeps = {
  findUrl: findPreviewUrl,
  probe: defaultProbe,
  runCommand: runVerificationCommand,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

function persist(result: PreviewCheckResult, logsDir: string | undefined): PreviewCheckResult {
  if (!logsDir) return result;
  try {
    mkdirSync(logsDir, { recursive: true });
    const evidencePath = join(logsDir, EVIDENCE_FILE);
    const evidence = { ...result.evidence, evidencePath };
    writeFileSync(evidencePath, `${JSON.stringify({ status: result.status, evidence }, null, 2)}\n`);
    return { status: result.status, evidence };
  } catch {
    return result;
  }
}

/** Finds the preview, waits until it answers, runs the smoke command with the URL in `urlEnv`. */
export async function runPreviewCheck(
  input: PreviewCheckInput,
  deps: Partial<PreviewCheckDeps> = {},
): Promise<PreviewCheckResult> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const { config, headSha, worktree } = input;
  const started = d.now();
  const deadline = started + config.readyTimeoutSeconds * 1000;
  const target = { owner: input.owner, repo: input.repo, prNumber: input.prNumber, headSha };
  const unavailable = (reason: string, url?: string): PreviewCheckResult =>
    persist(
      {
        status: 'preview-unavailable',
        evidence: {
          ...(url ? { url } : {}),
          headSha,
          command: config.command,
          durationMs: d.now() - started,
          artifacts: [],
          reason,
        },
      },
      input.logsDir,
    );

  let url: string | null = null;
  let lastReason = `no preview URL found for ${headSha.slice(0, 12)} (${describeSource(config.source)})`;
  for (;;) {
    try {
      url = await d.findUrl(input.octokit, target, config.source);
      if (url) {
        const status = await d.probe(new URL(config.readyPath, url).toString());
        if (status === config.expectedStatus) break;
        lastReason = `preview ${url} not ready (last status ${status ?? 'no response'}) after ${config.readyTimeoutSeconds}s`;
      }
    } catch (err) {
      lastReason = `preview lookup failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (d.now() >= deadline) return unavailable(lastReason, url ?? undefined);
    await d.sleep(POLL_INTERVAL_MS);
  }

  const r = await d.runCommand(config.command, {
    cwd: worktree,
    env: { ...input.env, [config.urlEnv]: url },
    ...(input.onPgid ? { onPgid: input.onPgid } : {}),
    timeoutMs: config.commandTimeoutSeconds * 1000,
  });
  const tail = stripAnsi(r.stderr.trim() !== '' ? r.stderr : r.stdout)
    .trim()
    .slice(-TAIL_CHARS);
  return persist(
    {
      status: r.ok ? 'pass' : 'fail',
      evidence: {
        url,
        headSha,
        command: config.command,
        exitCode: r.exitCode,
        durationMs: d.now() - started,
        outputTail: tail,
        artifacts: config.artifacts.filter((p) => existsSync(join(worktree, p))),
        ...(r.timedOut ? { reason: `preview command timed out after ${config.commandTimeoutSeconds}s` } : {}),
      },
    },
    input.logsDir,
  );
}

/** Bounded multi-line summary of a non-pass preview check, fed to the rework worker. */
export function previewReworkSummary(result: PreviewCheckResult): string {
  const e = result.evidence;
  const lines = [
    `Preview check: ${result.status}`,
    `URL: ${e.url ?? '-'}`,
    `SHA: ${e.headSha}`,
    `Command: ${e.command.join(' ')}`,
    ...(e.exitCode === undefined ? [] : [`Exit code: ${e.exitCode}`]),
    ...(e.reason ? [`Reason: ${e.reason}`] : []),
    ...(e.outputTail ? ['Output tail:', e.outputTail.slice(-SUMMARY_TAIL_CHARS)] : []),
  ];
  return lines.join('\n');
}

export const PREVIEW_REWORK_INSTRUCTIONS =
  "The PR's deployed preview failed the repo's preview smoke command. Fix the code so the deployed app passes; do not edit the preview config, the smoke command or its tests to make it pass.";
