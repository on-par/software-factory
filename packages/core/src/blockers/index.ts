// src/blockers/index.ts — barrel for the blocker filing API, re-exported from internal.ts (ADR-0004).

export { findDeclaredPrerequisites } from './declared-prerequisites.js';
export { addBlockedBy, listBlockedBy } from './dependencies.js';
export type { BlockedByItem, DependencyClientDeps } from './dependencies.js';
export {
  BLOCKER_MARKER_RE,
  BlockerClaimSchema,
  BlockerFilingError,
  MAX_BLOCKER_CHILDREN,
  blockerMarker,
  fileBlocker,
  hashBlockerClaim,
  renderBlockerBody,
} from './file-blocker.js';
export type { BlockerClaim, BlockerRefusalReason, FileBlockerDeps, FileBlockerResult } from './file-blocker.js';
export { MAX_AUTO_UNPARKS, createOctokitBlockedParkStore, pollBlockedParks } from './poller.js';
export type {
  BlockedParkOutcome,
  BlockedParkPollResult,
  BlockedParkStore,
  BlockerEvidence,
  PollBlockedParksOptions,
} from './poller.js';
