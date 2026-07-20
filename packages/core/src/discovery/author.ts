// src/discovery/author.ts — Turn a ranked DiscoveryCandidate into a reviewable draft Epic issue
import type { CommandResult } from '../utils/command-runner.js';
import { runCommand } from '../utils/command-runner.js';
import type { DiscoveryCandidate } from './index.js';

export const DISCOVERY_LABEL = 'discovery';
export const EXPLORING_LABEL = 'status:exploring';
const DISCOVERY_LABEL_COLOR = '5319e7'; // purple
const EXPLORING_LABEL_COLOR = 'fbca04'; // yellow
const DISCOVERY_LABEL_DESC = 'Discovery-phase idea Epic under exploration';
const EXPLORING_LABEL_DESC = 'Idea is being explored; owner review pending';

const TITLE_MAX_LEN = 120;

export const DEFAULT_OWNER_QUESTIONS: readonly string[] = [
  'Is this problem worth solving now?',
  'Does the proposed wedge/scope match how you would cut the first slice?',
  'What signal are we missing that would raise or lower the priority?',
];

export interface AuthorDraftEpicOptions {
  repoDir: string;
  candidate: DiscoveryCandidate;
  /** Optional richer content; when omitted, each is seeded deterministically from the candidate/signals. */
  userProblem?: string;
  whyNow?: string;
  wedge?: string;
  /** Owner questions; when omitted, DEFAULT_OWNER_QUESTIONS is used. */
  questions?: string[];
}

export interface AuthorDraftEpicDeps {
  now?: () => Date;
  run?: (argv: readonly string[], opts: { cwd: string }) => Promise<Pick<CommandResult, 'stdout' | 'ok'>>;
}

export type AuthorDraftEpicResult =
  | { created: true; issueNumber: number; issueUrl: string; labels: string[]; commentPosted: boolean }
  | { created: false; reason: 'duplicate'; duplicateOf: number }
  | { created: false; reason: 'create-failed'; detail: string };

// ---------- Pure helpers ----------

export function ideaSlug(hypothesis: string): string {
  return hypothesis
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

export function ideaMarker(hypothesis: string): string {
  return `<!-- factory:idea key="${ideaSlug(hypothesis)}" -->`;
}

export function draftEpicTitle(hypothesis: string): string {
  const truncated = hypothesis.length > TITLE_MAX_LEN ? `${hypothesis.slice(0, TITLE_MAX_LEN).trimEnd()}…` : hypothesis;
  return `Draft Epic: ${truncated}`;
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(draft epic:|epic:)\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?]+$/, '');
}

export function findDuplicate(
  existing: ReadonlyArray<{ number: number; title: string; body: string }>,
  candidate: DiscoveryCandidate,
  title: string,
): number | null {
  const marker = ideaMarker(candidate.hypothesis);
  const normalizedTitle = normalizeTitle(title);
  for (const item of existing) {
    if (item.body.includes(marker)) return item.number;
    if (normalizeTitle(item.title) === normalizedTitle) return item.number;
  }
  return null;
}

export function parseIssueNumber(url: string): number | null {
  const match = /(\d+)\s*$/.exec(url.trim());
  return match ? Number(match[1]) : null;
}

export function renderDraftEpicBody(options: AuthorDraftEpicOptions): string {
  const { candidate } = options;
  const questions = options.questions ?? DEFAULT_OWNER_QUESTIONS;
  const primarySignal = candidate.signals[0];

  const userProblem =
    options.userProblem ?? `Signal suggests: ${primarySignal.detail} — refine with the real user problem.`;
  const whyNow =
    options.whyNow ?? `Ranked score ${candidate.score}; surfaced from ${candidate.signals.length} signal(s).`;
  const wedge = options.wedge ?? 'To be scoped — smallest slice that tests the hypothesis.';

  const questionsList = questions.map((q) => `- ${q}`).join('\n');
  const signalsList = candidate.signals.map((s) => `- \`${s.reference}\` — ${s.detail}`).join('\n');

  return [
    '## Hypothesis',
    candidate.hypothesis,
    '',
    '## User problem',
    userProblem,
    '',
    '## Why now',
    whyNow,
    '',
    '## Rough wedge / scope',
    wedge,
    '',
    '## Open Questions',
    questionsList,
    '',
    '## Signals',
    signalsList,
    '',
    ideaMarker(candidate.hypothesis),
  ].join('\n');
}

// GitHub/gh has no per-comment pin API; this comment is the honest interpretation of "pinned" —
// a clearly-marked, structured owner-review comment instead of a true pin.
export function renderOwnerComment(questions: readonly string[]): string {
  const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  return [
    '📌 **Owner review needed**',
    '',
    numbered,
    '',
    'Answer in the comments. Set `validated` to proceed, `needs-work` to revise, or `wontfix` to drop.',
  ].join('\n');
}

// ---------- Main entry point ----------

export async function authorDraftEpic(
  options: AuthorDraftEpicOptions,
  deps: AuthorDraftEpicDeps = {},
): Promise<AuthorDraftEpicResult> {
  const run = deps.run ?? ((argv: readonly string[], o: { cwd: string }) => runCommand(argv, { cwd: o.cwd }));
  const { repoDir, candidate } = options;
  const questions = options.questions ?? DEFAULT_OWNER_QUESTIONS;

  const title = draftEpicTitle(candidate.hypothesis);

  const listResult = await run(
    [
      'gh',
      'issue',
      'list',
      '--label',
      DISCOVERY_LABEL,
      '--state',
      'all',
      '--limit',
      '100',
      '--json',
      'number,title,body',
    ],
    { cwd: repoDir },
  );
  let existing: Array<{ number: number; title: string; body: string }> = [];
  try {
    const parsed: unknown = JSON.parse(listResult.stdout);
    if (Array.isArray(parsed)) {
      existing = parsed as Array<{ number: number; title: string; body: string }>;
    }
  } catch {
    existing = [];
  }

  const dup = findDuplicate(existing, candidate, title);
  if (dup !== null) {
    return { created: false, reason: 'duplicate', duplicateOf: dup };
  }

  const labelListResult = await run(['gh', 'label', 'list', '--limit', '200', '--json', 'name'], { cwd: repoDir });
  let existingLabels: string[] = [];
  try {
    const parsed: unknown = JSON.parse(labelListResult.stdout);
    if (Array.isArray(parsed)) {
      existingLabels = (parsed as Array<{ name?: unknown }>)
        .map((item) => item.name)
        .filter((name): name is string => typeof name === 'string');
    }
  } catch {
    existingLabels = [];
  }

  const labelSpecs: Array<{ name: string; color: string; description: string }> = [
    { name: DISCOVERY_LABEL, color: DISCOVERY_LABEL_COLOR, description: DISCOVERY_LABEL_DESC },
    { name: EXPLORING_LABEL, color: EXPLORING_LABEL_COLOR, description: EXPLORING_LABEL_DESC },
  ];
  for (const spec of labelSpecs) {
    if (existingLabels.includes(spec.name)) continue;
    await run(['gh', 'label', 'create', spec.name, '--color', spec.color, '--description', spec.description], {
      cwd: repoDir,
    });
  }

  const body = renderDraftEpicBody(options);
  const createResult = await run(
    ['gh', 'issue', 'create', '--title', title, '--body', body, '--label', DISCOVERY_LABEL, '--label', EXPLORING_LABEL],
    { cwd: repoDir },
  );
  if (!createResult.ok) {
    return { created: false, reason: 'create-failed', detail: createResult.stdout || 'gh issue create failed' };
  }

  const issueNumber = parseIssueNumber(createResult.stdout);
  if (issueNumber === null) {
    return { created: false, reason: 'create-failed', detail: createResult.stdout || 'unparseable issue URL' };
  }

  const commentResult = await run(
    ['gh', 'issue', 'comment', String(issueNumber), '--body', renderOwnerComment(questions)],
    {
      cwd: repoDir,
    },
  );

  return {
    created: true,
    issueNumber,
    issueUrl: createResult.stdout.trim(),
    labels: [DISCOVERY_LABEL, EXPLORING_LABEL],
    commentPosted: commentResult.ok,
  };
}
