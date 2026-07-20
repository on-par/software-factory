// src/discovery/promote.ts — Advance a draft Epic through owner dialogue to validation, then decompose into stories
import type { CommandResult } from '../utils/command-runner.js';
import { runCommand } from '../utils/command-runner.js';
import { EXPLORING_LABEL, ideaSlug, parseIssueNumber } from './author.js';
import { DEFAULT_MAX_CANDIDATES } from './index.js';

export const VALIDATED_LABEL = 'validated';
export const WONTFIX_LABEL = 'wontfix';
export const ARCHIVED_LABEL = 'status:archived';
export const READY_LABEL = 'ready';
const READY_LABEL_COLOR = '0e8a16'; // green
const READY_LABEL_DESC = 'Story is INVEST-ready and eligible for the factory queue';
const ARCHIVED_LABEL_COLOR = 'cccccc';
const ARCHIVED_LABEL_DESC = 'Discovery idea archived (wontfix); not proposed again';
export const DEFAULT_MAX_STORIES = DEFAULT_MAX_CANDIDATES;

// ---------- Markers ----------

export function cycleMarker(iso: string): string {
  return `<!-- factory:cycle="${iso}" -->`;
}
const CYCLE_RE = /<!-- factory:cycle="([^"]+)" -->/;
export const PROMOTED_MARKER = '<!-- factory:promoted -->';
export const ARCHIVED_MARKER = '<!-- factory:archived -->';
export function storyMarker(epicNumber: number, key: string): string {
  return `<!-- factory:story epic="${epicNumber}" key="${key}" -->`;
}

// ---------- Lifecycle classifier ----------

export type EpicLifecycle = 'refine' | 'promote' | 'archive';

export function classifyLifecycle(labelNames: readonly string[]): EpicLifecycle {
  if (labelNames.includes(WONTFIX_LABEL)) return 'archive';
  if (labelNames.includes(VALIDATED_LABEL)) return 'promote';
  return 'refine';
}

// ---------- Comment ownership filter ----------

export function isFactoryComment(body: string): boolean {
  return body.includes('<!-- factory:') || body.includes('Owner review needed');
}

// ---------- Body helpers ----------

export function parseCycleTime(body: string): string | undefined {
  const match = CYCLE_RE.exec(body);
  return match ? match[1] : undefined;
}

export function setCycleMarker(body: string, iso: string): string {
  if (CYCLE_RE.test(body)) {
    return body.replace(CYCLE_RE, cycleMarker(iso));
  }
  return `${body}\n\n${cycleMarker(iso)}`;
}

export function ensureMarker(body: string, marker: string): string {
  if (body.includes(marker)) return body;
  return `${body}\n\n${marker}`;
}

export function upsertSection(body: string, heading: string, content: string): string {
  const lines = body.split('\n');
  const headingIndex = lines.findIndex((line) => line === heading);
  if (headingIndex === -1) {
    return `${body}\n\n${heading}\n\n${content}\n`;
  }
  let endIndex = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      endIndex = i;
      break;
    }
  }
  const before = lines.slice(0, headingIndex);
  const after = lines.slice(endIndex);
  const section = [heading, '', content, ''];
  return [...before, ...section, ...after].join('\n');
}

// ---------- Types ----------

export interface GherkinScenario {
  name: string;
  given: string[];
  when: string[];
  then: string[];
}

export interface DraftStory {
  title: string;
  role: string;
  want: string;
  soThat: string;
  investNote?: string;
  scenarios: GherkinScenario[];
}

export interface EpicView {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: Array<{ author: string; body: string; createdAt: string }>;
}

// ---------- Story body renderer ----------

export function renderStoryBody(story: DraftStory, epicNumber: number): string {
  const invest = story.investNote ? `\n\n**INVEST check:** ${story.investNote}` : '';
  const scenarios = story.scenarios
    .map((s) => {
      const line = (kw: string, items: string[]) => items.map((t, i) => `  ${i === 0 ? kw : 'And'} ${t}`).join('\n');
      return [`Scenario: ${s.name}`, line('Given', s.given), line('When', s.when), line('Then', s.then)]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
  return [
    '## User Story',
    `As a ${story.role}, I want ${story.want}, so that ${story.soThat}.${invest}`,
    '',
    '## Acceptance Criteria',
    '',
    scenarios,
    '',
    `Epic: #${epicNumber}`,
    '',
    storyMarker(epicNumber, ideaSlug(story.title)),
  ].join('\n');
}

// ---------- Deterministic seed decomposition ----------

function extractHypothesis(epic: EpicView): string {
  const lines = epic.body.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === '## Hypothesis');
  if (headingIndex !== -1) {
    for (let i = headingIndex + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('## ')) break;
      if (line !== '') return line;
    }
  }
  return epic.title.replace(/^Draft Epic:\s*/, '');
}

export function seedStories(epic: EpicView): DraftStory[] {
  const hypothesis = extractHypothesis(epic);
  return [
    {
      title: `Deliver smallest slice: ${hypothesis}`,
      role: 'product owner',
      want: `the smallest slice that tests "${hypothesis}"`,
      soThat: 'we validate the idea with real usage before investing further',
      investNote:
        'Independent, Negotiable, Valuable, Estimable, Small, Testable — seeded from the validated Epic; refine before build.',
      scenarios: [
        {
          name: 'Smallest slice ships and is verifiable',
          given: [`the validated Epic #${epic.number}`],
          when: ['the slice is implemented and the verification gate runs'],
          then: ['the acceptance criteria pass', 'the change merges and closes this story'],
        },
      ],
    },
  ];
}

// ---------- Checklist renderer ----------

export function renderStoryChecklist(items: Array<{ number: number; title: string }>): string {
  return items.map((i) => `- [ ] #${i.number} — ${i.title}`).join('\n');
}

// ---------- Result union ----------

export type AdvanceDraftEpicResult =
  | { action: 'refined'; issueNumber: number; incorporated: number; changed: boolean }
  | { action: 'promoted'; issueNumber: number; storyNumbers: number[]; reusedNumbers: number[] }
  | { action: 'archived'; issueNumber: number }
  | { action: 'already-promoted'; issueNumber: number }
  | { action: 'already-archived'; issueNumber: number }
  | { action: 'error'; detail: string };

// ---------- Options / deps ----------

export interface AdvanceDraftEpicOptions {
  repoDir: string;
  issueNumber: number;
  /** Owner-supplied decomposition; when omitted, seedStories() is used. */
  stories?: DraftStory[];
  /** Volume cap on child stories per cycle. Defaults to DEFAULT_MAX_STORIES. */
  maxStories?: number;
}

export interface AdvanceDraftEpicDeps {
  now?: () => Date;
  run?: (argv: readonly string[], opts: { cwd: string }) => Promise<Pick<CommandResult, 'stdout' | 'ok'>>;
}

type Runner = (argv: readonly string[], opts: { cwd: string }) => Promise<Pick<CommandResult, 'stdout' | 'ok'>>;

async function ensureLabelsExist(
  run: Runner,
  repoDir: string,
  specs: Array<{ name: string; color: string; description: string }>,
): Promise<void> {
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

  for (const spec of specs) {
    if (existingLabels.includes(spec.name)) continue;
    await run(['gh', 'label', 'create', spec.name, '--color', spec.color, '--description', spec.description], {
      cwd: repoDir,
    });
  }
}

// ---------- Main entry point ----------

export async function advanceDraftEpic(
  options: AdvanceDraftEpicOptions,
  deps: AdvanceDraftEpicDeps = {},
): Promise<AdvanceDraftEpicResult> {
  const run = deps.run ?? ((argv: readonly string[], o: { cwd: string }) => runCommand(argv, { cwd: o.cwd }));
  const now = deps.now ?? (() => new Date());
  const { repoDir, issueNumber } = options;

  const viewResult = await run(
    ['gh', 'issue', 'view', String(issueNumber), '--json', 'number,title,body,labels,comments'],
    { cwd: repoDir },
  );
  if (!viewResult.ok) {
    return { action: 'error', detail: viewResult.stdout || 'gh issue view failed' };
  }

  let view: EpicView;
  try {
    const parsed = JSON.parse(viewResult.stdout) as {
      number: number;
      title: string;
      body: string;
      labels?: Array<{ name: string }>;
      comments?: Array<{ author?: { login?: string }; body: string; createdAt: string }>;
    };
    view = {
      number: parsed.number,
      title: parsed.title,
      body: parsed.body,
      labels: (parsed.labels ?? []).map((l) => l.name),
      comments: (parsed.comments ?? []).map((c) => ({
        author: c.author?.login ?? '',
        body: c.body,
        createdAt: c.createdAt,
      })),
    };
  } catch {
    return { action: 'error', detail: 'unparseable gh issue view output' };
  }

  const lifecycle = classifyLifecycle(view.labels);

  if (lifecycle === 'promote' && view.body.includes(PROMOTED_MARKER)) {
    return { action: 'already-promoted', issueNumber };
  }
  if (lifecycle === 'archive' && view.body.includes(ARCHIVED_MARKER)) {
    return { action: 'already-archived', issueNumber };
  }

  if (lifecycle === 'archive') {
    await ensureLabelsExist(run, repoDir, [
      { name: ARCHIVED_LABEL, color: ARCHIVED_LABEL_COLOR, description: ARCHIVED_LABEL_DESC },
    ]);
    await run(
      ['gh', 'issue', 'edit', String(issueNumber), '--add-label', ARCHIVED_LABEL, '--remove-label', EXPLORING_LABEL],
      { cwd: repoDir },
    );
    await run(['gh', 'issue', 'edit', String(issueNumber), '--body', ensureMarker(view.body, ARCHIVED_MARKER)], {
      cwd: repoDir,
    });
    await run(['gh', 'issue', 'close', String(issueNumber), '--reason', 'not planned'], { cwd: repoDir });
    return { action: 'archived', issueNumber };
  }

  if (lifecycle === 'promote') {
    const stories = (options.stories ?? seedStories(view)).slice(0, options.maxStories ?? DEFAULT_MAX_STORIES);

    await ensureLabelsExist(run, repoDir, [
      { name: READY_LABEL, color: READY_LABEL_COLOR, description: READY_LABEL_DESC },
    ]);

    const listResult = await run(
      [
        'gh',
        'issue',
        'list',
        '--label',
        READY_LABEL,
        '--state',
        'all',
        '--limit',
        '200',
        '--json',
        'number,title,body',
      ],
      { cwd: repoDir },
    );
    let existingChildren: Array<{ number: number; title: string; body: string }> = [];
    try {
      const parsed: unknown = JSON.parse(listResult.stdout);
      if (Array.isArray(parsed)) {
        existingChildren = parsed as Array<{ number: number; title: string; body: string }>;
      }
    } catch {
      existingChildren = [];
    }

    const storyNumbers: number[] = [];
    const reusedNumbers: number[] = [];
    const childItems: Array<{ number: number; title: string }> = [];

    for (const story of stories) {
      const key = ideaSlug(story.title);
      const marker = storyMarker(issueNumber, key);
      const existing = existingChildren.find((child) => child.body.includes(marker));
      if (existing) {
        reusedNumbers.push(existing.number);
        childItems.push({ number: existing.number, title: story.title });
        continue;
      }

      const createResult = await run(
        [
          'gh',
          'issue',
          'create',
          '--title',
          story.title,
          '--body',
          renderStoryBody(story, issueNumber),
          '--label',
          READY_LABEL,
        ],
        { cwd: repoDir },
      );
      if (!createResult.ok) continue;
      const childNumber = parseIssueNumber(createResult.stdout);
      if (childNumber === null) continue;
      storyNumbers.push(childNumber);
      childItems.push({ number: childNumber, title: story.title });
    }

    let body = upsertSection(view.body, '## Stories', renderStoryChecklist(childItems));
    body = ensureMarker(body, PROMOTED_MARKER);
    await run(['gh', 'issue', 'edit', String(issueNumber), '--body', body], { cwd: repoDir });
    await run(['gh', 'issue', 'edit', String(issueNumber), '--remove-label', EXPLORING_LABEL], { cwd: repoDir });

    return { action: 'promoted', issueNumber, storyNumbers, reusedNumbers };
  }

  // refine
  const cycleTime = parseCycleTime(view.body);
  const newComments = view.comments.filter(
    (c) => !isFactoryComment(c.body) && (cycleTime === undefined || c.createdAt > cycleTime),
  );

  if (newComments.length === 0) {
    return { action: 'refined', issueNumber, incorporated: 0, changed: false };
  }

  const existingAnswers = extractOwnerAnswers(view.body);
  const newBullets = newComments.map(
    (c) => `- _(${c.createdAt.slice(0, 10)})_ @${c.author}: ${firstNonEmptyLine(c.body)}`,
  );
  const combined = [existingAnswers, ...newBullets].filter(Boolean).join('\n');
  const bodyWithAnswers = upsertSection(view.body, '## Owner answers', combined);
  const body = setCycleMarker(bodyWithAnswers, now().toISOString());
  await run(['gh', 'issue', 'edit', String(issueNumber), '--body', body], { cwd: repoDir });

  return { action: 'refined', issueNumber, incorporated: newComments.length, changed: true };
}

function firstNonEmptyLine(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

function extractOwnerAnswers(body: string): string {
  const lines = body.split('\n');
  const headingIndex = lines.findIndex((line) => line === '## Owner answers');
  if (headingIndex === -1) return '';
  let endIndex = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      endIndex = i;
      break;
    }
  }
  return lines
    .slice(headingIndex + 1, endIndex)
    .join('\n')
    .trim();
}
