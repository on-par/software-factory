// packages/product/src/decompose/story-map.ts — the story-map backbone (#633).

import type { IntentStatementId } from '@on-par/contracts';

import type { IntentDoc, IntentStatement } from '../intent/index.js';

export type JourneyStageId = 'access' | 'discover' | 'capture' | 'process' | 'deliver' | 'learn' | 'other';

export interface JourneyStage {
  id: JourneyStageId;
  /** Human label used in story notes and summaries. */
  label: string;
  /** Lowercase substrings that put a statement on this stage. Empty for the terminal stage. */
  cues: readonly string[];
}

export interface BackboneStep {
  stage: JourneyStage;
  /** 1-based position in this doc's compacted backbone. */
  rank: number;
  /** The `scope` statement IDs sitting on this step, in doc order. */
  scopeIds: readonly IntentStatementId[];
}

export interface StoryMap {
  /** The journey this doc describes, in catalog order, ranks compacted 1..n. */
  backbone: readonly BackboneStep[];
}

export const JOURNEY_STAGES: readonly JourneyStage[] = [
  {
    id: 'access',
    label: 'Get in',
    cues: [
      'sign in',
      'log in',
      'login',
      'sign up',
      'register',
      'authenticate',
      'onboard',
      'invite',
      'permission',
      'access',
    ],
  },
  {
    id: 'discover',
    label: 'Find the work',
    cues: ['find', 'search', 'browse', 'discover', 'list', 'filter', 'view', 'see the'],
  },
  {
    id: 'capture',
    label: 'Capture the work',
    cues: ['create', 'add ', 'enter', 'upload', 'import', 'submit', 'record', 'draft'],
  },
  {
    id: 'process',
    label: 'Act on the work',
    cues: [
      'process',
      'validate',
      'approve',
      'review',
      'edit',
      'update',
      'retry',
      'run ',
      'resolve',
      'cancel',
      'delete',
    ],
  },
  {
    id: 'deliver',
    label: 'Deliver the result',
    cues: ['export', 'send', 'publish', 'notify', 'share', 'deliver', 'download', 'email', 'print'],
  },
  {
    id: 'learn',
    label: 'Learn from it',
    cues: ['report', 'dashboard', 'metric', 'analytic', 'audit', 'history', 'measure', 'chart', 'insight'],
  },
  { id: 'other', label: 'Unmapped', cues: [] },
];

/** Every stage (catalog order) with at least one cue that is a substring of `text`. Never includes `other`. */
export function stagesMatching(text: string): readonly JourneyStage[] {
  const lowered = text.toLowerCase();
  return JOURNEY_STAGES.filter((stage) => stage.cues.some((cue) => lowered.includes(cue)));
}

const OTHER_STAGE = JOURNEY_STAGES.find((s) => s.id === 'other')!;

/** The earliest-matching stage for `text`, falling back to the terminal `other` stage. */
function primaryStage(text: string): JourneyStage {
  return stagesMatching(text)[0] ?? OTHER_STAGE;
}

/** Derive the journey backbone from a doc's scope and outcome statements. Pure. */
export function buildStoryMap(doc: IntentDoc): StoryMap {
  const scopes = doc.statements.filter((s) => s.dimension === 'scope');
  const outcomes = doc.statements.filter((s) => s.dimension === 'outcome');

  const scopeIdsByStage = new Map<JourneyStageId, IntentStatementId[]>();
  for (const scope of scopes) {
    const stageId = primaryStage(scope.text).id;
    const bucket = scopeIdsByStage.get(stageId);
    if (bucket) {
      bucket.push(scope.id);
    } else {
      scopeIdsByStage.set(stageId, [scope.id]);
    }
  }

  const outcomeStageIds = new Set<JourneyStageId>(
    outcomes.flatMap((o: IntentStatement) => stagesMatching(o.text).map((stage) => stage.id)),
  );

  const backbone: BackboneStep[] = [];
  let rank = 0;
  for (const stage of JOURNEY_STAGES) {
    const scopeIds = scopeIdsByStage.get(stage.id) ?? [];
    if (scopeIds.length === 0 && !outcomeStageIds.has(stage.id)) {
      continue;
    }
    rank += 1;
    backbone.push({ stage, rank, scopeIds });
  }

  return { backbone };
}
