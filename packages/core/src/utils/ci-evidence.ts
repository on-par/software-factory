import type { Octokit } from '@octokit/rest';

import type { CiCodeScanningAlert, CiFailingCheck, CiFailureEvidence, CiJobLogExcerpt } from '../types/index.js';

import { redactSecrets } from '../filing/redact.js';

import { isPassingConclusion, listAllCheckRuns } from './ci-watch.js';
import { redactGitHubCredentials } from './github-credentials.js';

export const CI_EVIDENCE_LIMITS = {
  maxChecks: 10,
  maxAlerts: 10,
  maxSummaryChars: 500,
  maxMessageChars: 300,
  maxJobLogs: 3,
  maxLogLines: 150,
  maxLogChars: 16000,
  maxFlagged: 10,
} as const;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function collectCiFailureEvidence(opts: {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
  prNumber: number;
}): Promise<CiFailureEvidence> {
  const { octokit, owner, repo, ref, prNumber } = opts;
  const errors: string[] = [];
  let truncated = false;
  const clip = (text: string, max: number): string => {
    if (text.length <= max) return text;
    truncated = true;
    return `${text.slice(0, max - 1)}…`;
  };

  let failingChecks: CiFailingCheck[] = [];
  try {
    const runs = await listAllCheckRuns(octokit, owner, repo, ref, 100, 10);
    const failing = runs.filter((r) => r.status === 'completed' && !isPassingConclusion(r.conclusion));
    if (failing.length > CI_EVIDENCE_LIMITS.maxChecks) truncated = true;
    failingChecks = failing.slice(0, CI_EVIDENCE_LIMITS.maxChecks).map((r) => {
      const text = r.output?.summary || r.output?.title || '';
      const url = r.html_url || r.details_url;
      return {
        name: r.name ?? '(unnamed)',
        conclusion: r.conclusion ?? 'null',
        ...(url ? { url } : {}),
        ...(text ? { summary: clip(text, CI_EVIDENCE_LIMITS.maxSummaryChars) } : {}),
      };
    });
  } catch (err) {
    errors.push(`checks: ${errorMessage(err)}`);
  }

  let alerts: CiCodeScanningAlert[] = [];
  if (failingChecks.some((c) => /codeql/i.test(c.name))) {
    try {
      const { data } = await octokit.rest.codeScanning.listAlertsForRepo({
        owner,
        repo,
        ref: `refs/pull/${prNumber}/merge`,
        state: 'open',
        per_page: 100,
      });
      if (data.length > CI_EVIDENCE_LIMITS.maxAlerts) truncated = true;
      alerts = data.slice(0, CI_EVIDENCE_LIMITS.maxAlerts).map((a) => {
        const loc = a.most_recent_instance?.location;
        const location = loc?.path ? loc.path + (loc.start_line ? `:${loc.start_line}` : '') : '(unknown location)';
        return {
          ...(typeof a.number === 'number' ? { number: a.number } : {}),
          ruleId: a.rule?.id ?? a.rule?.name ?? '(unknown rule)',
          location,
          message: clip(
            a.most_recent_instance?.message?.text ?? a.rule?.description ?? '',
            CI_EVIDENCE_LIMITS.maxMessageChars,
          ),
        };
      });
    } catch (err) {
      errors.push(`code-scanning: ${errorMessage(err)}`);
    }
  }

  return { failingChecks, alerts, truncated, ...(errors.length > 0 ? { errors } : {}) };
}

const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /;
const ANSI_ESCAPE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const RUN_STEP = /^##\[group\]Run (.+)$/;
const GROUP = /^##\[group\](.+)$/;
const ERROR_LINE = /^##\[error\]/;
const LINE_START_SUMMARY =
  /^\s*(?:(?:--- )?FAIL(?:ED)?\b|(?:Test Files|Test Suites|Tests):?\s+\d+ failed|\d+ failing\b)/;
const FAILED_TESTS_BANNER = /Failed Tests\b/;
const isSummaryMarker = (line: string): boolean => LINE_START_SUMMARY.test(line) || FAILED_TESTS_BANNER.test(line);
const TEST_MARKER = /^\s*[✘✗×]\s/;
const CONTEXT_BEFORE = 20;
const CONTEXT_AFTER = 30;

export interface SelectedLogExcerpt {
  excerpt: string;
  truncated: boolean;
  failingStep?: string;
}

function stepHeaders(lines: readonly string[]): number[] {
  let current = -1;
  let sawRun = false;
  return lines.map((line, i) => {
    const isRun = RUN_STEP.test(line);
    if (isRun || (!sawRun && GROUP.test(line))) current = i;
    sawRun ||= isRun;
    return current;
  });
}

function keepWindows(total: number, anchors: readonly number[]): boolean[] {
  const keep = Array.from({ length: total }, () => false);
  let used = 0;
  let segments = 0;
  for (const anchor of anchors) {
    for (let j = Math.max(0, anchor - CONTEXT_BEFORE); j <= Math.min(total - 1, anchor + CONTEXT_AFTER); j++) {
      if (keep[j]) continue;
      const [prev, next] = [j > 0 && keep[j - 1], j + 1 < total && keep[j + 1]];
      const nextSegments = segments + (prev && next ? -1 : prev || next ? 0 : 1);
      if (used + 1 + Math.max(nextSegments - 1, 0) > CI_EVIDENCE_LIMITS.maxLogLines) return keep;
      keep[j] = true;
      used++;
      segments = nextSegments;
    }
  }
  return keep;
}

function joinKept(lines: readonly string[], keep: readonly boolean[]): string {
  const out: string[] = [];
  let omitted = 0;
  for (const [i, line] of lines.entries()) {
    if (!keep[i]) {
      omitted++;
      continue;
    }
    if (omitted > 0 && out.length > 0) out.push(`… ${omitted} lines omitted …`);
    omitted = 0;
    out.push(line);
  }
  return out.join('\n');
}

export function selectLogExcerpt(lines: readonly string[]): SelectedLogExcerpt {
  const { maxLogLines, maxLogChars } = CI_EVIDENCE_LIMITS;
  const firstError = lines.findIndex((l) => ERROR_LINE.test(l));
  const markers = lines.flatMap((l, i) => (i === firstError || isSummaryMarker(l) || TEST_MARKER.test(l) ? [i] : []));
  if (markers.length === 0) {
    const tail = lines.slice(-maxLogLines).join('\n');
    const capped = tail.length > maxLogChars;
    return { excerpt: capped ? tail.slice(-maxLogChars) : tail, truncated: capped || lines.length > maxLogLines };
  }
  const steps = stepHeaders(lines);
  const failingHeader = steps[firstError >= 0 ? firstError : markers[0]];
  const rank = (i: number): number => (steps[i] === failingHeader ? 0 : 2) + (isSummaryMarker(lines[i]) ? 0 : 1);
  const keep = keepWindows(
    lines.length,
    [...markers].sort((a, b) => rank(a) - rank(b)),
  );
  const joined = joinKept(lines, keep);
  const capped = joined.length > maxLogChars;
  const failingStep = failingHeader >= 0 ? lines[failingHeader].replace(/^##\[group\](?:Run )?/, '').trim() : '';
  return {
    excerpt: capped ? joined.slice(0, maxLogChars) : joined,
    truncated: capped || keep.includes(false),
    ...(failingStep ? { failingStep } : {}),
  };
}

export async function collectFailingJobLogs(opts: {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
  checkNames: readonly string[];
  changedFiles?: readonly string[];
}): Promise<{ jobLogs: CiJobLogExcerpt[]; errors: string[] }> {
  const { octokit, owner, repo, ref, checkNames, changedFiles = [] } = opts;
  const jobLogs: CiJobLogExcerpt[] = [];
  const errors: string[] = [];
  let runs;
  try {
    const all = await listAllCheckRuns(octokit, owner, repo, ref, 100, 10);
    runs = all
      .filter((r) => r.status === 'completed' && !isPassingConclusion(r.conclusion))
      .filter((r) => r.name !== undefined && r.name !== null && checkNames.includes(r.name))
      .slice(0, CI_EVIDENCE_LIMITS.maxJobLogs);
  } catch (err) {
    return { jobLogs, errors: [`checks: ${errorMessage(err)}`] };
  }
  for (const run of runs) {
    const name = run.name ?? '(unnamed)';
    if (typeof run.id !== 'number') {
      errors.push(`${name}: no job id`);
      continue;
    }
    try {
      const { data } = await octokit.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: run.id });
      const text = typeof data === 'string' ? data : String(data);
      const files = new Set<string>();
      for (const f of changedFiles) if (text.includes(f)) files.add(f);
      for (const m of text.matchAll(/^\s*(?:File|Path)\s*:\s*(\S+)/gim)) if (m[1]) files.add(m[1]);
      const commits = new Set<string>();
      for (const m of text.matchAll(/\bcommit\s*:?\s*([0-9a-f]{7,40})\b/gi)) if (m[1]) commits.add(m[1]);
      const flagged = (set: Set<string>): string[] => [...set].slice(0, CI_EVIDENCE_LIMITS.maxFlagged);
      const lines = text.split('\n').map((l) => l.replace(LOG_TIMESTAMP, '').replace(ANSI_ESCAPE, ''));
      const { excerpt, truncated, failingStep } = selectLogExcerpt(lines);
      const redact = (value: string): string => redactSecrets(redactGitHubCredentials(value));
      const url = run.html_url || run.details_url;
      jobLogs.push({
        name,
        jobId: run.id,
        excerpt: redact(excerpt),
        truncated,
        ...(failingStep ? { failingStep: redact(failingStep) } : {}),
        ...(url ? { url } : {}),
        ...(files.size > 0 ? { files: flagged(files) } : {}),
        ...(commits.size > 0 ? { commits: flagged(commits) } : {}),
      });
    } catch (err) {
      errors.push(`${name}: ${errorMessage(err)}`);
    }
  }
  return { jobLogs, errors };
}
