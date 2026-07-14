import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { FactoryEvent } from '../types/index.js';

const exec = promisify(execCb);
type ReportRun = (command: string, opts: { cwd: string; timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;

export type LocalRunOutcome = 'ready' | 'parked' | 'failed' | 'escalated';

export interface LocalRunReportInput {
  issue: number;
  eventsFile: string;
  reportsDir: string;
  startedAt: string;
  outcome: LocalRunOutcome;
  profile: string;
  branch?: string;
  worktree?: string;
  specPath?: string;
  route?: string;
  reason?: string;
}

export interface LocalRunReport {
  path: string;
  markdown: string;
}

export type LocalRunReportRenderInput = Omit<LocalRunReportInput, 'eventsFile' | 'reportsDir'> & {
  reportTime: string;
  events: FactoryEvent[];
  changedFiles: string[];
  diffStat: string;
};

export interface LocalRunReportDeps {
  now?: () => Date;
  run?: ReportRun;
}

export async function writeLocalRunReport(
  input: LocalRunReportInput,
  deps: LocalRunReportDeps = {},
): Promise<LocalRunReport> {
  const now = deps.now ?? (() => new Date());
  const reportTime = now().toISOString();
  const events = readIssueEvents(input.eventsFile, input.issue, input.startedAt);
  const changedFiles = await readChangedFiles(input.worktree, deps.run);
  const diffStat = await readDiffStat(input.worktree, deps.run);
  const markdown = renderLocalRunReport({
    ...input,
    reportTime,
    events,
    changedFiles,
    diffStat,
  });
  const path = resolve(input.reportsDir, `${safeTimestamp(reportTime)}-issue-${input.issue}-${input.outcome}.md`);
  mkdirSync(input.reportsDir, { recursive: true });
  writeFileSync(path, markdown);
  return { path, markdown };
}

export function renderLocalRunReport(input: LocalRunReportRenderInput): string {
  const attempts = parseModelAttempts(input.events);
  const failures = input.events.filter(event => ['fail', 'escalate'].includes(event.type) || /failed \(/.test(event.msg));
  const verification = input.events.filter(event =>
    ['check', 'rework', 'ship', 'ready', 'skip-ci'].includes(event.type) ||
    /\bverify\b|\bCI\b/.test(event.msg)
  );

  return [
    `# Local-only run report: issue #${input.issue}`,
    '',
    '## Summary',
    `- Outcome: ${input.outcome}`,
    `- Profile: ${input.profile}`,
    `- Route: ${input.route ?? 'unknown'}`,
    `- Branch: ${input.branch ?? 'unknown'}`,
    `- Worktree: ${input.worktree ?? 'unknown'}`,
    `- Spec: ${input.specPath ?? 'unknown'}`,
    `- Started: ${input.startedAt}`,
    `- Reported: ${input.reportTime}`,
    input.reason ? `- Reason: ${input.reason}` : undefined,
    '',
    '## Models Attempted',
    attempts.length > 0
      ? attempts.map(attempt => `- ${attempt.model} for ${attempt.task}, attempt ${attempt.attempt}${attempt.reason ? `: ${attempt.reason}` : ''}`).join('\n')
      : '- No model attempts recorded.',
    '',
    '## Changed Files',
    input.changedFiles.length > 0
      ? input.changedFiles.map(file => `- ${file}`).join('\n')
      : '- No changed files recorded.',
    '',
    '## Diff Stat',
    fenced(input.diffStat || 'No diff against origin/main.'),
    '',
    '## Command Observations',
    commandObservations(input.events),
    '',
    '## Verification',
    verification.length > 0
      ? verification.map(event => `- ${event.type}: ${event.msg}`).join('\n')
      : '- No verification events recorded.',
    '',
    '## Failures And Escalations',
    failures.length > 0
      ? failures.map(event => `- ${event.type}: ${event.msg}`).join('\n')
      : '- None recorded.',
    '',
    '## Event Timeline',
    input.events.length > 0
      ? input.events.map(event => `- ${event.ts} ${event.type}: ${event.msg}`).join('\n')
      : '- No events recorded for this run window.',
    '',
  ].filter(line => line !== undefined).join('\n');
}

function readIssueEvents(eventsFile: string, issue: number, startedAt: string): FactoryEvent[] {
  if (!existsSync(eventsFile)) return [];
  const started = Date.parse(startedAt);
  return readFileSync(eventsFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        const event = JSON.parse(line) as FactoryEvent;
        if (event.issue !== String(issue)) return [];
        if (Number.isFinite(started) && Date.parse(event.ts) < started) return [];
        return [event];
      } catch {
        return [];
      }
    });
}

async function readChangedFiles(worktree?: string, run: ReportRun = exec): Promise<string[]> {
  if (!worktree) return [];
  try {
    const result = await run('git status --short', { cwd: worktree, timeout: 30_000, maxBuffer: 1024 * 1024 });
    return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function readDiffStat(worktree?: string, run: ReportRun = exec): Promise<string> {
  if (!worktree) return '';
  try {
    const result = await run('git diff --stat origin/main...HEAD', { cwd: worktree, timeout: 30_000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    return '';
  }
}

function parseModelAttempts(events: FactoryEvent[]): { model: string; task: string; attempt: string; reason?: string }[] {
  const attempts: { model: string; task: string; attempt: string; reason?: string }[] = [];
  for (const event of events) {
    const started = event.msg.match(/^Trying (.+) for (.+) \(attempt (\d+)\)$/);
    if (started) {
      attempts.push({ model: started[1], task: started[2], attempt: started[3] });
      continue;
    }
    const failed = event.msg.match(/^(.+) failed \((.+)\) on (.+)$/);
    if (failed) attempts.push({ model: failed[1], task: failed[3], attempt: '?', reason: failed[2] });
  }
  return attempts;
}

function commandObservations(events: FactoryEvent[]): string {
  const commands = events.filter(event => event.msg.startsWith('$ ') || /command/i.test(event.msg));
  if (commands.length === 0) {
    return [
      '- No command-level observations were captured in the event log.',
      '- This is expected for the current local command-agent spike when it fails before producing a valid action.',
      '- Use the empty-response trace work in #170 to capture raw command-loop detail.',
    ].join('\n');
  }
  return commands.map(event => `- ${event.type}: ${event.msg}`).join('\n');
}

function fenced(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

function safeTimestamp(ts: string): string {
  return ts.replace(/[:.]/g, '-');
}
