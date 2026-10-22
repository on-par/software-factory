// src/daemon/repo-route-status.ts — The one reason→HTTP-status table for the
// attach, pause/resume and detach routes in factoryd-http.ts. A `draining`
// entry answers 409 on every route (ADR-0058). The Record is exhaustive, so a
// new failure reason is a compile error until it is mapped here (#1620).

import type { AttachFailureReason } from './repos-attach.js';
import type { SetRepoStateFailureReason } from './repos-pause-resume.js';

export type RepoRouteFailureReason = AttachFailureReason | SetRepoStateFailureReason | 'unknown-repo';

const REPO_FAILURE_STATUS: Record<RepoRouteFailureReason, 400 | 404 | 409> = {
  'invalid-request': 400,
  'not-a-git-checkout': 400,
  'origin-mismatch': 400,
  'missing-factory-config': 400,
  'unknown-repo': 404,
  draining: 409,
  detached: 409,
  'state-root-mismatch': 409,
};

export function repoFailureStatus(reason: RepoRouteFailureReason): 400 | 404 | 409 {
  return REPO_FAILURE_STATUS[reason];
}
