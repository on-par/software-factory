// src/blockers/index.ts — barrel for the blocker filing API, re-exported from internal.ts (ADR-0004).

export { addBlockedBy, listBlockedBy } from './dependencies.js';
export type { BlockedByItem, DependencyClientDeps } from './dependencies.js';
export {
  BlockerClaimSchema,
  BlockerFilingError,
  MAX_BLOCKER_CHILDREN,
  blockerMarker,
  fileBlocker,
  hashBlockerClaim,
  renderBlockerBody,
} from './file-blocker.js';
export type { BlockerClaim, BlockerRefusalReason, FileBlockerDeps, FileBlockerResult } from './file-blocker.js';
