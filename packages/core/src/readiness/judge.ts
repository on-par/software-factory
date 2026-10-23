// src/readiness/judge.ts — three-way model verdict on ticket readiness (ADR-0167, #3467)
import { z } from 'zod';

import { stripHiddenContent } from '../filing/sanitize.js';
import { UNTRUSTED_ISSUE_BODY_NOTICE, wrapUntrustedIssueBody } from '../utils/untrusted-input.js';
import { extractJsonObject } from './decompose.js';
import { stripEnrichedBlock } from './enrich.js';
import { readCachedVerdict, readinessCacheKey, writeCachedVerdict } from './judge-cache.js';

export const READINESS_PROMPT_VERSION = 'readiness-judge/v1';
export const READINESS_INPUT_CAP = 64_000;

export interface ReadinessInput {
  title: string;
  body: string;
  truncated: boolean;
}

/** Sanitize and cap the ticket text. Enriched blocks, comments and invisible characters never reach the model or the hash. */
export function prepareReadinessInput(input: { title: string; body: string }): ReadinessInput {
  const title = stripHiddenContent(input.title).trim();
  let body = stripHiddenContent(stripEnrichedBlock(input.body)).trim();
  let truncated = false;
  if (body.length > READINESS_INPUT_CAP) {
    body = `${body.slice(0, READINESS_INPUT_CAP)}\n\n[truncated: the ticket body exceeded 64000 characters; judge only the text above]`;
    truncated = true;
  }
  return { title, body, truncated };
}

function neutralizeTags(text: string): string {
  return text
    .replace(/<untrusted-issue-body>/gi, '[untrusted-issue-body]')
    .replace(/<\/untrusted-issue-body>/gi, '[/untrusted-issue-body]');
}

const RUBRIC = [
  'You judge whether a ticket is ready to be built by an autonomous coding agent. Give one of three verdicts.',
  '- "ready": the outcome is clear and buildable as written. "assumptions" and "questions" are empty.',
  '- "ready-with-assumptions": buildable once 1-5 stated assumptions are made. "questions" is empty.',
  '- "not-ready": there are 1-5 blocking questions only a human can answer, for example a contradiction or a missing product decision. It may also carry up to 5 assumptions.',
  "Plain text with no headings is fine. Never judge size. If the author grants latitude, assume, don't ask.",
  'Output exactly one JSON object and nothing else, shaped like:',
  '{"schemaVersion": 1, "verdict": "ready" | "ready-with-assumptions" | "not-ready", "summary": "<=200 chars", "assumptions": [{"aspect": "...", "text": "..."}], "questions": [{"aspect": "...", "text": "..."}]}',
  'The aspect is one of: problem, scope, acceptance, verification, contradiction, decision, other.',
  'Each item text is a single line of at most 300 characters. The summary is at most 200 characters.',
].join('\n');

const INTRO = 'Judge the readiness of the ticket below.';

function ticketBlock(input: ReadinessInput): string {
  return wrapUntrustedIssueBody(`Title: ${neutralizeTags(input.title)}\n\n${neutralizeTags(input.body)}`);
}

export function buildReadinessJudgePrompt(input: ReadinessInput): string {
  return [INTRO, UNTRUSTED_ISSUE_BODY_NOTICE, RUBRIC, ticketBlock(input)].join('\n\n');
}

export function buildReadinessJudgeRepairPrompt(
  input: ReadinessInput,
  failure: { previousOutput: string; error: string },
): string {
  return [
    INTRO,
    UNTRUSTED_ISSUE_BODY_NOTICE,
    RUBRIC,
    `Your previous reply was rejected: ${neutralizeTags(failure.error.slice(0, 500))}`,
    wrapUntrustedIssueBody(`Previous reply (untrusted):\n${neutralizeTags(failure.previousOutput.slice(0, 8000))}`),
    ticketBlock(input),
    'Reply again with exactly one corrected JSON object.',
  ].join('\n\n');
}

const aspect = z.enum(['problem', 'scope', 'acceptance', 'verification', 'contradiction', 'decision', 'other']);
const item = z
  .object({
    aspect,
    text: z
      .string()
      .min(1)
      .max(300)
      .regex(/^[^\r\n]+$/),
  })
  .strict();
const base = { schemaVersion: z.literal(1), summary: z.string().max(200) };

export const ReadinessVerdictSchema = z.discriminatedUnion('verdict', [
  z
    .object({
      ...base,
      verdict: z.literal('ready'),
      assumptions: z.array(item).max(0),
      questions: z.array(item).max(0),
    })
    .strict(),
  z
    .object({
      ...base,
      verdict: z.literal('ready-with-assumptions'),
      assumptions: z.array(item).min(1).max(5),
      questions: z.array(item).max(0),
    })
    .strict(),
  z
    .object({
      ...base,
      verdict: z.literal('not-ready'),
      assumptions: z.array(item).max(5),
      questions: z.array(item).min(1).max(5),
    })
    .strict(),
]);

export type ReadinessVerdict = z.infer<typeof ReadinessVerdictSchema>;
export type ReadinessParseErrorKind = 'invalid-json' | 'schema-violation';
export type ReadinessErrorKind = 'model-error' | ReadinessParseErrorKind;

export function parseReadinessVerdict(
  output: string,
): { ok: true; verdict: ReadinessVerdict } | { ok: false; errorKind: ReadinessParseErrorKind; detail: string } {
  const json = extractJsonObject(output);
  if (json === undefined) return { ok: false, errorKind: 'invalid-json', detail: 'no JSON object found' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { ok: false, errorKind: 'invalid-json', detail: err instanceof Error ? err.message : String(err) };
  }
  const result = ReadinessVerdictSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, errorKind: 'schema-violation', detail: detail.slice(0, 500) };
  }
  return { ok: true, verdict: result.data };
}

export function detectEpic(input: { title: string; labels?: readonly string[] }): boolean {
  if (/^\s*(\[epic\]|epic:)/i.test(input.title)) return true;
  return (input.labels ?? []).some((l) => l.trim().toLowerCase() === 'epic');
}

export type ReadinessRunner = (prompt: string) => Promise<{ model: string; output: string; cost: number }>;

export type JudgeReadinessResult =
  | { kind: 'skipped'; reason: 'epic' }
  | {
      kind: 'verdict';
      verdict: ReadinessVerdict;
      model: string;
      cost: number;
      cached: boolean;
      promptVersion: string;
      bodyHash: string;
    }
  | { kind: 'error'; errorKind: ReadinessErrorKind; detail: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function judgeReadiness(opts: {
  title: string;
  body: string;
  labels?: readonly string[];
  run: ReadinessRunner;
  cache?: { dir: string };
  rejudge?: boolean;
}): Promise<JudgeReadinessResult> {
  if (detectEpic(opts)) return { kind: 'skipped', reason: 'epic' };

  const input = prepareReadinessInput(opts);
  const bodyHash = readinessCacheKey(READINESS_PROMPT_VERSION, input.title, input.body);

  if (opts.cache && !opts.rejudge) {
    const entry = readCachedVerdict(opts.cache.dir, bodyHash);
    if (entry && entry.promptVersion === READINESS_PROMPT_VERSION) {
      const parsed = ReadinessVerdictSchema.safeParse(entry.verdict);
      if (parsed.success) {
        return {
          kind: 'verdict',
          verdict: parsed.data,
          model: entry.model,
          cost: 0,
          cached: true,
          promptVersion: READINESS_PROMPT_VERSION,
          bodyHash,
        };
      }
    }
  }

  let first: { model: string; output: string; cost: number };
  try {
    first = await opts.run(buildReadinessJudgePrompt(input));
  } catch (err) {
    return { kind: 'error', errorKind: 'model-error', detail: errorMessage(err) };
  }

  let model = first.model;
  let cost = first.cost;
  let parsed = parseReadinessVerdict(first.output);
  if (!parsed.ok) {
    try {
      const repair = await opts.run(
        buildReadinessJudgeRepairPrompt(input, { previousOutput: first.output, error: parsed.detail }),
      );
      model = repair.model;
      cost += repair.cost;
      parsed = parseReadinessVerdict(repair.output);
    } catch (err) {
      return { kind: 'error', errorKind: 'model-error', detail: errorMessage(err) };
    }
  }
  if (!parsed.ok) return { kind: 'error', errorKind: parsed.errorKind, detail: parsed.detail };

  if (opts.cache) {
    writeCachedVerdict(opts.cache.dir, bodyHash, {
      schemaVersion: 1,
      promptVersion: READINESS_PROMPT_VERSION,
      bodyHash,
      model,
      verdict: parsed.verdict,
      createdAt: new Date().toISOString(),
    });
  }
  return {
    kind: 'verdict',
    verdict: parsed.verdict,
    model,
    cost,
    cached: false,
    promptVersion: READINESS_PROMPT_VERSION,
    bodyHash,
  };
}
