// Review/approval queue exports re-exported from internal.ts (keeps that file under its max-lines ceiling)
export { createOctokitCollaboratorPermissionClient, isTrustedApprover } from './approval.js';
export {
  claimIterateCommand,
  createFileIterateStore,
  createOctokitIterateGitHub,
  pollIterateCommands,
  queueCiPendingRework,
} from './iterate-command.js';
export { parseReworkCommand, pollCommentRework } from './comment-rework-trigger.js';
export type { ReviewReworkSource } from './review-rework-trigger.js';
export {
  claimReviewRework,
  createFileReviewReworkStore,
  createOctokitReviewReworkGitHub,
  pollReviewRework,
} from './review-rework-trigger.js';
export * from '../run/review-rework-cap.js';
export {
  DEFAULT_MAX_LAND_DEFERRALS,
  clearLandDeferred,
  decideLandDeferral,
  dueLandDeferrals,
  landDeferredFile,
  readLandDeferred,
  resolveMaxLandDeferrals,
  upsertLandDeferred,
  type LandDeferralDecision,
  type LandDeferredRecord,
} from './land-deferred.js'; // land-only retry queue (#3957)
export {
  allProvidersDown,
  allProvidersDownReleasePayload,
  PROVIDER_LEVEL_REASONS,
  stageBlocked,
  TIMED_BREAKER_REASONS,
} from '../run/stage-blocked.js';
export type { AllProvidersDownResult, ProviderDown } from '../run/stage-blocked.js';
export type { GateStage, StageBlockedResult } from '../run/stage-blocked.js';
export * from '../agent-memory/index.js'; // optional per-lane PLAN memory (#3624)
export {
  choosePrerequisiteStack,
  parsePrerequisiteStackMarker,
  renderPrerequisiteStackMarker,
  resolveQueueStackOnOpenPrerequisite,
  type PrerequisiteRestackDecision,
  type PrerequisiteStackTarget,
} from './prerequisite-stack.js';
