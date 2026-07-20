import { existsSync, readdirSync, readFileSync } from 'node:fs';

import type { CheckSummary, FactoryEvent } from '../types/index.js';
import { readIssueEvents } from './local-run.js';

const REWORK_EVENT_TYPES = new Set(['rework', 'check', 'ship', 'ready']);
const RESULT_EMOJI: Record<string, string> = { PASS: '✅', FAIL: '❌', SKIP: '⚪' };
const SPEC_SUMMARY_LIMIT = 600;

export interface EvidencePackRenderInput {
  issue: number;
  checkSummary?: CheckSummary;
  reworkRounds?: number;
  specSummary?: string;
  events: FactoryEvent[];
  logFiles: string[];
}

export interface EvidencePackGatherInput {
  issue: number;
  checkSummary?: CheckSummary;
  reworkRounds?: number;
  specPath?: string;
  eventsFile?: string;
  startedAt?: string;
  logsDir?: string;
}

export function renderEvidencePack(input: EvidencePackRenderInput): string {
  const { checkSummary, reworkRounds, specSummary, events, logFiles } = input;

  const summaryParts = [
    checkSummary
      ? `Checkers: ${checkSummary.passes} pass, ${checkSummary.failures} fail, ${checkSummary.skips} skip`
      : undefined,
    reworkRounds !== undefined ? `Rework rounds: ${reworkRounds}` : undefined,
  ].filter((part): part is string => part !== undefined);

  const verificationEvents = events.filter((event) => REWORK_EVENT_TYPES.has(event.type));
  const finalResult = checkSummary
    ? checkSummary.failures === 0
      ? 'all checkers passed'
      : `${checkSummary.failures} failure(s) remain`
    : undefined;

  return [
    '## 🔎 Evidence pack',
    '',
    summaryParts.length > 0 ? summaryParts.join(' · ') : 'No verification data available.',
    '',
    section(
      'Checker verdicts',
      checkSummary && checkSummary.results.length > 0
        ? checkSummary.results
            .map(
              (result) =>
                `- ${RESULT_EMOJI[result.result] ?? '⚪'} ${result.result} \`${result.checker}\` — ${truncate(result.details, 200)}`,
            )
            .join('\n')
        : '- No checker results recorded.',
    ),
    section('Frozen spec', specSummary ?? '- Spec summary unavailable.'),
    section(
      'Rework & verification',
      [
        `- Rework rounds: ${reworkRounds ?? 0}`,
        ...verificationEvents.map((event) => `- ${event.type}: ${event.msg}`),
        finalResult ? `- Final result: ${finalResult}` : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n'),
    ),
    section(
      'Event timeline',
      events.length > 0
        ? events.map((event) => `- ${event.ts} ${event.type}: ${event.msg}`).join('\n')
        : '- No events recorded for this run window.',
    ),
    section(
      'Logs',
      logFiles.length > 0
        ? logFiles.map((file) => `- \`.factory/logs/${file}\``).join('\n')
        : '- No per-issue log files found; see the event timeline above.',
    ),
  ].join('\n');
}

export function gatherEvidencePack(input: EvidencePackGatherInput): string {
  const { issue, checkSummary, reworkRounds, specPath, eventsFile, startedAt, logsDir } = input;

  const specSummary = readSpecSummary(specPath);
  const events = eventsFile && startedAt ? readIssueEvents(eventsFile, issue, startedAt) : [];
  const logFiles = readLogFiles(logsDir, issue);

  return renderEvidencePack({ issue, checkSummary, reworkRounds, specSummary, events, logFiles });
}

function section(title: string, body: string): string {
  return [`<details>`, `<summary>${title}</summary>`, '', body, '', `</details>`, ''].join('\n');
}

function readSpecSummary(specPath?: string): string | undefined {
  if (!specPath) return undefined;
  try {
    if (!existsSync(specPath)) return undefined;
    const raw = readFileSync(specPath, 'utf-8');
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
    const goalMatch = body.match(/## Goal\n([\s\S]*?)(?:\n## |$)/);
    const excerpt = goalMatch ? goalMatch[1] : body.slice(0, SPEC_SUMMARY_LIMIT);
    return truncate(excerpt.trim(), SPEC_SUMMARY_LIMIT);
  } catch {
    return undefined;
  }
}

function readLogFiles(logsDir: string | undefined, issue: number): string[] {
  if (!logsDir) return [];
  try {
    if (!existsSync(logsDir)) return [];
    const pattern = new RegExp(`^issue-${issue}\\.`);
    return readdirSync(logsDir)
      .filter((file) => pattern.test(file))
      .sort();
  } catch {
    return [];
  }
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
