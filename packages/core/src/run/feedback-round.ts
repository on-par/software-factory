// packages/core/src/run/feedback-round.ts — a feedback round on a factory PR: collect unhandled trusted feedback, triage it, rework or re-plan, then answer each item and resolve what was fixed (#3910)
import { z } from 'zod';

import type { EventKind } from '../events/kinds.js';
import { parseReworkCommand } from '../queue/comment-rework-trigger.js';
import { extractJsonObject } from '../readiness/decompose.js';
import type { CheckSummary } from '../types/index.js';
import { UNTRUSTED_REVIEW_FEEDBACK_NOTICE, wrapUntrustedReviewFeedback } from '../utils/untrusted-input.js';
import type { FeedbackRoundGitHub } from './feedback-github.js';
import { ReviewReworkError } from './review-rework.js';

export interface FeedbackItem {
  kind: 'review' | 'inline' | 'comment';
  id: number;
  author: string;
  body: string;
  url: string;
  path?: string;
  line?: number;
  threadId?: string;
  /** The top-level comment of the thread an inline item replies to; GitHub only accepts replies to that one. */
  inReplyTo?: number;
}

export interface FeedbackRoundTarget {
  prNumber: number;
}

const DispositionSchema = z.object({
  id: z.number(),
  kind: z.enum(['review', 'inline', 'comment']),
  verdict: z.enum(['actionable', 'question', 'out-of-scope']),
  changesSpec: z.boolean().default(false),
  summary: z.string().default(''),
  answer: z.string().optional(),
  reason: z.string().optional(),
  followUpIssue: z.number().optional(),
});

export type FeedbackDisposition = z.infer<typeof DispositionSchema>;

export interface FeedbackRoundPlan {
  prNumber: number;
  items: FeedbackItem[];
  dispositions: FeedbackDisposition[];
  replan: boolean;
  reviewers: string[];
  /** Undefined when nothing is actionable. */
  summary: CheckSummary | undefined;
}

type TriageRun = (prompt: string) => Promise<{ model: string; output: string; cost: number }>;
type RoundLog = (type: EventKind, message: string) => void;

const MARKER_RE = /<!-- factory:feedback-handled (review|inline|comment):(\d+) -->/g;
const FEEDBACK_MAX_CHARS = 20_000;
const REVISED_SPEC_OPEN = '<!-- factory:revised-spec -->';
const REVISED_SPEC_CLOSE = '<!-- /factory:revised-spec -->';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const itemKey = (item: Pick<FeedbackItem, 'kind' | 'id'>): string => `${item.kind}:${item.id}`;

export function feedbackHandledMarker(item: Pick<FeedbackItem, 'kind' | 'id'>): string {
  return `<!-- factory:feedback-handled ${itemKey(item)} -->`;
}

function handledKeys(bodies: readonly string[]): Set<string> {
  const handled = new Set<string>();
  for (const body of bodies) {
    for (const m of body.matchAll(MARKER_RE)) handled.add(`${m[1]}:${m[2]}`);
  }
  return handled;
}

/** Trusted, unhandled feedback on the PR, oldest id first. Factory-authored, empty and marker-handled items are dropped. */
export async function collectFeedbackItems(opts: {
  github: FeedbackRoundGitHub;
  prNumber: number;
  isTrusted: (login: string) => Promise<boolean>;
}): Promise<FeedbackItem[]> {
  const { github, prNumber, isTrusted } = opts;
  const viewer = (await github.viewerLogin()).toLowerCase();
  const [reviews, inline, comments, threads] = await Promise.all([
    github.listReviews(prNumber),
    github.listReviewComments(prNumber),
    github.listIssueComments(prNumber),
    github.listReviewThreads(prNumber),
  ]);
  const isViewer = (login: string): boolean => login.toLowerCase() === viewer;
  const handled = handledKeys([
    ...comments.filter((c) => isViewer(c.login)).map((c) => c.body),
    ...inline.filter((c) => isViewer(c.login)).map((c) => c.body),
  ]);
  const threadOf = (commentId: number): string | undefined =>
    threads.find((t) => t.commentIds.includes(commentId))?.threadId;

  const candidates: FeedbackItem[] = [
    ...reviews.map((r): FeedbackItem => ({ kind: 'review', id: r.id, author: r.login, body: r.body, url: r.htmlUrl })),
    ...inline.map((c): FeedbackItem => ({
      kind: 'inline',
      id: c.id,
      author: c.login,
      body: c.body,
      url: c.htmlUrl,
      path: c.path,
      ...(c.line === undefined ? {} : { line: c.line }),
      ...(threadOf(c.id) === undefined ? {} : { threadId: threadOf(c.id) }),
      ...(c.inReplyTo === undefined ? {} : { inReplyTo: c.inReplyTo }),
    })),
    ...comments.map((c): FeedbackItem => {
      const command = parseReworkCommand(c.body);
      return { kind: 'comment', id: c.id, author: c.login, body: command ?? c.body, url: c.htmlUrl };
    }),
  ];

  const trust = new Map<string, boolean>();
  const items: FeedbackItem[] = [];
  for (const item of candidates) {
    if (isViewer(item.author) || item.body.trim() === '' || handled.has(itemKey(item))) continue;
    let trusted = trust.get(item.author);
    if (trusted === undefined) {
      trusted = await isTrusted(item.author);
      trust.set(item.author, trusted);
    }
    if (trusted) items.push(item);
  }
  return items.sort((a, b) => a.id - b.id);
}

const failClosed = (item: FeedbackItem): FeedbackDisposition => ({
  id: item.id,
  kind: item.kind,
  verdict: 'actionable',
  changesSpec: false,
  summary: '',
});

function renderItem(item: FeedbackItem): string {
  const where = item.path === undefined ? '' : `${item.path}${item.line === undefined ? '' : `:${item.line}`} `;
  return `- ${item.kind} ${item.id} ${where}(@${item.author}):\n  ${item.body}`;
}

/** One model call over every item; any parse failure, or a missing or unknown id, falls back to actionable. */
export async function triageFeedback(opts: {
  items: readonly FeedbackItem[];
  spec: string;
  run: TriageRun;
}): Promise<FeedbackDisposition[]> {
  const { items, spec, run } = opts;
  if (items.length === 0) return [];
  const prompt = [
    'You triage review feedback on a pull request the factory opened. Judge each item against the frozen spec below.',
    'For every item answer with a verdict:',
    '- "actionable": it asks for a code or doc change in scope of this PR.',
    '- "question": it asks something to answer; put the reply in "answer".',
    '- "out-of-scope": it asks for work outside this PR; put the reason in "reason".',
    'Set "changesSpec" to true only when an actionable item changes the PR\'s goal, scope or acceptance criteria.',
    'Put a one-line description of the change (actionable) in "summary".',
    'Reply with one JSON object: {"items":[{"id":<number>,"kind":"review"|"inline"|"comment","verdict":...,"changesSpec":<boolean>,"summary":"...","answer":"...","reason":"..."}]} and nothing else.',
    '',
    '## Frozen spec',
    spec,
    '',
    '## Feedback items',
    UNTRUSTED_REVIEW_FEEDBACK_NOTICE,
    ...items.map((item) => wrapUntrustedReviewFeedback(renderItem(item))),
  ].join('\n');

  const byKey = new Map<string, FeedbackDisposition>();
  try {
    const { output } = await run(prompt);
    const json = extractJsonObject(output);
    const parsed: unknown = json === undefined ? undefined : JSON.parse(json);
    const raw = typeof parsed === 'object' && parsed !== null && 'items' in parsed ? parsed.items : undefined;
    for (const entry of Array.isArray(raw) ? raw : []) {
      const d = DispositionSchema.safeParse(entry);
      if (d.success) byKey.set(itemKey(d.data), d.data);
    }
  } catch {
    // unparsable or failed triage reads as no dispositions, so every item fails closed
  }
  return items.map((item) => byKey.get(itemKey(item)) ?? failClosed(item));
}

const dispositionFor = (
  dispositions: readonly FeedbackDisposition[],
  item: FeedbackItem,
): FeedbackDisposition | undefined => dispositions.find((d) => d.kind === item.kind && d.id === item.id);

/** The actionable items as a one-result CheckSummary for the rework worker; undefined when nothing is actionable. */
export function feedbackReworkSummary(
  items: readonly FeedbackItem[],
  dispositions: readonly FeedbackDisposition[],
): CheckSummary | undefined {
  const actionable = items.filter((i) => dispositionFor(dispositions, i)?.verdict === 'actionable');
  if (actionable.length === 0) return undefined;
  let inner = ['Feedback to address on the open PR:', ...actionable.map(renderItem)].join('\n');
  if (inner.length > FEEDBACK_MAX_CHARS) inner = `${inner.slice(0, FEEDBACK_MAX_CHARS)}\n… (feedback truncated)`;
  return {
    failures: 1,
    passes: 0,
    skips: 0,
    total: 1,
    results: [
      {
        checker: 'review_feedback',
        result: 'FAIL',
        details: `${UNTRUSTED_REVIEW_FEEDBACK_NOTICE}\n${wrapUntrustedReviewFeedback(inner)}`,
      },
    ],
  };
}

/** Reads, triages and plans one round; throws ReviewReworkError unless the PR is open. */
export async function prepareFeedbackRound(opts: {
  github: FeedbackRoundGitHub;
  target: FeedbackRoundTarget;
  spec: string;
  isTrusted: (login: string) => Promise<boolean>;
  run: TriageRun;
  log: RoundLog;
}): Promise<FeedbackRoundPlan> {
  const { github, target, spec, isTrusted, run, log } = opts;
  const pull = await github.getPull(target.prNumber);
  if (pull.state !== 'open') {
    throw new ReviewReworkError(`PR #${target.prNumber} must be open for a feedback round; found ${pull.state}`);
  }
  const items = await collectFeedbackItems({ github, prNumber: target.prNumber, isTrusted });
  const dispositions = await triageFeedback({ items, spec, run });
  const count = (verdict: FeedbackDisposition['verdict']): number =>
    dispositions.filter((d) => d.verdict === verdict).length;
  log(
    'feedback_round_triaged',
    `PR #${target.prNumber}: ${items.length} feedback item(s) — ${count('actionable')} actionable, ${count('question')} question, ${count('out-of-scope')} out-of-scope`,
  );
  const excluded = new Set([pull.author.toLowerCase(), (await github.viewerLogin()).toLowerCase()]);
  const reviewers = [...new Set(items.map((i) => i.author))].filter((a) => !excluded.has(a.toLowerCase()));
  return {
    prNumber: target.prNumber,
    items,
    dispositions,
    replan: dispositions.some((d) => d.verdict === 'actionable' && d.changesSpec),
    reviewers,
    summary: feedbackReworkSummary(items, dispositions),
  };
}

/** The reply posted where the item was left, ending in the handled marker. */
export function renderFeedbackReply(
  item: FeedbackItem,
  disposition: FeedbackDisposition,
  ctx: { repo: string; headSha: string | undefined },
): string {
  let text: string;
  if (disposition.verdict === 'actionable') {
    const fixed =
      ctx.headSha === undefined
        ? 'Fixed in the latest push'
        : `Fixed in [\`${ctx.headSha.slice(0, 7)}\`](https://github.com/${ctx.repo}/commit/${ctx.headSha})`;
    text = disposition.summary === '' ? fixed : `${fixed}: ${disposition.summary}`;
  } else if (disposition.verdict === 'question') {
    text =
      disposition.answer ?? 'Thanks for the question; see the PR description for the reasoning behind this change.';
  } else {
    text = `Not changed: ${disposition.reason ?? 'this is outside the scope of this PR.'}`;
    if (disposition.followUpIssue !== undefined) text += `\n\nFollow-up: #${disposition.followUpIssue}`;
  }
  const quote = item.kind === 'inline' ? [] : [`> [@${item.author}](${item.url})`, ''];
  return [...quote, text, '', feedbackHandledMarker(item)].join('\n');
}

function withRevisedSpec(body: string, summary: string): string {
  const block = `${REVISED_SPEC_OPEN}\n## Revised spec\n\n${summary}\n${REVISED_SPEC_CLOSE}`;
  const start = body.indexOf(REVISED_SPEC_OPEN);
  const end = body.indexOf(REVISED_SPEC_CLOSE);
  if (start >= 0 && end > start) return `${body.slice(0, start)}${block}${body.slice(end + REVISED_SPEC_CLOSE.length)}`;
  return body === '' ? block : `${body}\n\n${block}`;
}

/** Replies to every item, records a revised spec, resolves fixed threads and re-requests review; GitHub errors warn and continue. */
export async function publishFeedbackRound(opts: {
  github: FeedbackRoundGitHub;
  plan: FeedbackRoundPlan;
  repo: string;
  headSha: string | undefined;
  revisedSpecSummary?: string;
  log: RoundLog;
}): Promise<{ replied: number; resolved: number; reviewersRequested: string[] }> {
  const { github, plan, repo, headSha, revisedSpecSummary, log } = opts;
  const warn = (what: string, err: unknown): void =>
    log('rework', `feedback round: ${what} failed — ${errorMessage(err)}`);

  const replied = new Set<string>();
  for (const item of plan.items) {
    const disposition = dispositionFor(plan.dispositions, item) ?? failClosed(item);
    const body = renderFeedbackReply(item, disposition, { repo, headSha });
    try {
      if (item.kind === 'inline') await github.replyToReviewComment(plan.prNumber, item.inReplyTo ?? item.id, body);
      else await github.postIssueComment(plan.prNumber, body);
      replied.add(itemKey(item));
    } catch (err) {
      warn(`reply to ${itemKey(item)}`, err);
    }
  }

  if (revisedSpecSummary !== undefined) {
    try {
      const pull = await github.getPull(plan.prNumber);
      await github.updatePullBody(plan.prNumber, withRevisedSpec(pull.body, revisedSpecSummary));
    } catch (err) {
      warn('revised-spec update of the PR body', err);
    }
  }

  const toResolve = new Set<string>();
  for (const item of plan.items) {
    const verdict = dispositionFor(plan.dispositions, item)?.verdict ?? 'actionable';
    if (item.kind === 'inline' && verdict === 'actionable' && item.threadId && replied.has(itemKey(item))) {
      toResolve.add(item.threadId);
    }
  }
  let resolved = 0;
  if (toResolve.size > 0) {
    try {
      const open = new Set(
        (await github.listReviewThreads(plan.prNumber)).filter((t) => !t.isResolved).map((t) => t.threadId),
      );
      for (const threadId of toResolve) {
        if (!open.has(threadId)) continue;
        try {
          await github.resolveThread(threadId);
          resolved++;
        } catch (err) {
          warn(`resolving thread ${threadId}`, err);
        }
      }
    } catch (err) {
      warn('listing review threads', err);
    }
  }

  let reviewersRequested: string[] = [];
  if (plan.reviewers.length > 0) {
    try {
      await github.requestReviewers(plan.prNumber, plan.reviewers);
      reviewersRequested = [...plan.reviewers];
    } catch (err) {
      warn('re-requesting review', err);
    }
  }
  log(
    'feedback_round_replied',
    `PR #${plan.prNumber}: replied to ${replied.size}/${plan.items.length} item(s), resolved ${resolved} thread(s), re-requested review from ${reviewersRequested.length} reviewer(s)`,
  );
  return { replied: replied.size, resolved, reviewersRequested };
}
