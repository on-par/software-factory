import { existsSync, readdirSync, readFileSync } from 'node:fs';

import type { PrClassifierClaim, PrShadowVerdict } from '../review/classifier.js';
import type { ReviewRouting } from '../review/routing.js';
import { renderCheckerFindings } from '../checkers/index.js';
import { specPaths } from '../spec/index.js';
import type { CheckSummary, FactoryEvent } from '../types/index.js';
import { readIssueEvents } from './local-run.js';

const REWORK_EVENT_TYPES = new Set(['rework', 'check', 'ship', 'ready']);
const RESULT_EMOJI: Record<string, string> = { PASS: '✅', FAIL: '❌', SKIP: '⚪' };
const DESIGN_CONTRACT_HEADINGS = ['Behavior contract', 'Verification plan'];

export interface EvidencePackRenderInput {
  issue: number;
  checkSummary?: CheckSummary;
  reworkRounds?: number;
  designMarkdown?: string;
  events: FactoryEvent[];
  logFiles: string[];
  /** PR classifier decision (#1724); the section is omitted when undefined. */
  reviewRouting?: ReviewRouting;
}

export interface EvidencePackGatherInput {
  issue: number;
  checkSummary?: CheckSummary;
  reworkRounds?: number;
  specPath?: string;
  eventsFile?: string;
  startedAt?: string;
  logsDir?: string;
  reviewRouting?: ReviewRouting;
}

export function renderEvidencePack(input: EvidencePackRenderInput): string {
  const { checkSummary, reworkRounds, designMarkdown, events, logFiles, reviewRouting } = input;

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
            .map((result) =>
              [
                `- ${RESULT_EMOJI[result.result] ?? '⚪'} ${result.result} \`${result.checker}\` — ${truncate(result.details, 200)}`,
                ...(result.findings !== undefined ? renderCheckerFindings(result.findings).map((l) => `  ${l}`) : []),
              ].join('\n'),
            )
            .join('\n')
        : '- No checker results recorded.',
    ),
    ...(reviewRouting ? [section('Review routing', renderReviewRouting(reviewRouting))] : []),
    section(
      'Design artifact',
      designMarkdown === undefined ? '- No design artifact recorded.' : extractDesignContract(designMarkdown),
    ),
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
      'Logs',
      logFiles.length > 0
        ? logFiles.map((file) => `- \`.factory/logs/${file}\``).join('\n')
        : '- No per-issue log files found.',
    ),
  ].join('\n');
}

export function gatherEvidencePack(input: EvidencePackGatherInput): string {
  const { issue, checkSummary, reworkRounds, specPath, eventsFile, startedAt, logsDir } = input;

  const designMarkdown = readDesignMarkdown(specPath);
  const events = eventsFile && startedAt ? readIssueEvents(eventsFile, issue, startedAt) : [];
  const logFiles = readLogFiles(logsDir, issue);

  return renderEvidencePack({
    issue,
    checkSummary,
    reworkRounds,
    designMarkdown,
    events,
    logFiles,
    reviewRouting: input.reviewRouting,
  });
}

function renderReviewRouting(routing: ReviewRouting): string {
  const lines = [
    routing.floor === null
      ? `- Floor: unavailable (classifier error: ${routing.error ?? 'unknown'})`
      : `- Floor: **${routing.floor}**`,
    routing.gated
      ? `- Gate: held for a human — \`${routing.reason ?? 'classifier'}\``
      : '- Gate: none — auto-merge eligible',
  ];
  if (routing.rules.length === 0) {
    lines.push('- No rules fired.');
  } else {
    for (const rule of routing.rules) {
      const paths = rule.paths.map((p) => `\`${p}\``).join(', ');
      lines.push(`- \`${rule.id}\` (${rule.class}): ${paths === '' ? '(no paths)' : truncate(paths, 300)}`);
    }
  }
  if (routing.shadow) lines.push(...renderShadowVerdict(routing.shadow));
  return lines.join('\n');
}

function renderShadowVerdict(shadow: PrShadowVerdict): string[] {
  const bullets = (items: string[]): string[] =>
    items.length === 0 ? ['  - none'] : items.map((item) => `  - ${item}`);
  const claim = (c: PrClassifierClaim): string =>
    c.citation === '' ? truncate(c.text, 200) : `${truncate(c.text, 200)} — \`${c.citation}\``;
  return [
    '- **Shadow model verdict — shadow — no effect**',
    shadow.modelClass === null
      ? `  - Model class: unavailable — ${shadow.reason ?? 'unknown'}`
      : `  - Model class: **${shadow.modelClass}** (\`${shadow.model ?? 'unknown'}\`, \`${shadow.promptVersion}\`, policy \`${shadow.policyVersion}\`)`,
    `  - Final class: ${shadow.finalClass ?? 'unavailable'} (= floor)`,
    '  - Cited claims:',
    ...bullets(shadow.claims.map(claim)).map((l) => `  ${l}`),
    '  - Unsupported claims (no citation):',
    ...bullets(shadow.unsupportedClaims.map(claim)).map((l) => `  ${l}`),
    '  - Not inspected:',
    ...bullets(shadow.notInspected.map((s) => truncate(s, 200))).map((l) => `  ${l}`),
    `  - ADRs consulted: ${shadow.adrIds.length === 0 ? 'none' : shadow.adrIds.join(', ')}`,
  ];
}

function section(title: string, body: string): string {
  return [`<details>`, `<summary>${title}</summary>`, '', body, '', `</details>`, ''].join('\n');
}

function extractDesignContract(markdown: string): string {
  const parts = DESIGN_CONTRACT_HEADINGS.flatMap((heading) => {
    const match = markdown.match(new RegExp(`^### ${heading}\\n([\\s\\S]*?)(?=^#{2,3} |(?![\\s\\S]))`, 'm'));
    return match ? [`### ${heading}\n\n${match[1].trim()}`] : [];
  });
  return parts.length > 0 ? parts.join('\n\n') : '- Design artifact has no Behavior contract or Verification plan.';
}

function readDesignMarkdown(specPath?: string): string | undefined {
  if (!specPath) return undefined;
  try {
    const { designMd } = specPaths(specPath);
    if (!existsSync(designMd)) return undefined;
    return readFileSync(designMd, 'utf-8');
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
