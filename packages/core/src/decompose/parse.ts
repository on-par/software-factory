// src/decompose/parse.ts — validates a decompose model response into an epic +
// INVEST-clean child stories, or a list of human-readable errors. Never throws (#606).

import { checkInvest, EpicSchema, StorySchema, tryDeserialize } from '@on-par/contracts';
import type { Epic, Story } from '@on-par/contracts';
import { z } from 'zod';

/** Fewer stories than this is not a decomposition. */
export const MIN_DECOMPOSITION_STORIES = 2;
/** More than this and the "epic" is a roadmap. */
export const MAX_DECOMPOSITION_STORIES = 8;

export interface ProposedDecomposition {
  epic: Epic;
  stories: readonly Story[];
}

export const ProposedDecompositionSchema = z.object({
  epic: EpicSchema,
  stories: z.array(StorySchema).min(MIN_DECOMPOSITION_STORIES).max(MAX_DECOMPOSITION_STORIES),
});

export type DecompositionParseResult =
  { ok: true; decomposition: ProposedDecomposition } | { ok: false; errors: readonly string[] };

const FENCED_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)```/;

function extractJsonCandidate(raw: string): string | undefined {
  const trimmed = raw.trim();
  const fenced = FENCED_JSON_RE.exec(trimmed);
  if (fenced) return fenced[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  return trimmed.slice(start, end + 1);
}

/** Fence-strip, decode + validate against the contracts schemas, then INVEST-gate every story. */
export function parseDecomposition(raw: string): DecompositionParseResult {
  const candidate = extractJsonCandidate(raw);
  if (candidate === undefined) {
    return { ok: false, errors: ['no JSON object found in model output'] };
  }

  const decoded = tryDeserialize(ProposedDecompositionSchema, candidate);
  if (!decoded.ok) {
    return { ok: false, errors: decoded.errors.map((e) => `schema: ${e}`) };
  }

  const { epic, stories } = decoded.value;

  const investErrors = stories.flatMap((story) =>
    checkInvest(story).violations.map(
      (violation) => `story "${story.title}" fails INVEST (${violation.letter}): ${violation.reason}`,
    ),
  );
  if (investErrors.length > 0) {
    return { ok: false, errors: investErrors };
  }

  const storyTitles = stories.map((s) => s.title.trim());
  const childrenMatch =
    epic.children.length === stories.length && epic.children.every((child, i) => child.trim() === storyTitles[i]);
  if (!childrenMatch) {
    return { ok: false, errors: [`epic children do not match the ${stories.length} proposed stories`] };
  }

  return { ok: true, decomposition: { epic, stories } };
}
