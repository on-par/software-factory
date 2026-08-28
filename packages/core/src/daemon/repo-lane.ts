// src/daemon/repo-lane.ts — Canonical rendering of a (repo, lane) pair as the
// flat string `owner/name#laneId`. Pure formatter, no I/O; not wired into any
// event/log/URL/SSE path (#969).

import type { RepoSlug } from '../types/index.js';

/** Render a repo slug and lane id as the canonical flat form `owner/name#laneId`,
 *  e.g. renderRepoLane('on-par/sound-buddy', 'lane-2') === 'on-par/sound-buddy#lane-2'. */
export function renderRepoLane(repo: RepoSlug, laneId: string): string {
  return `${repo}#${laneId}`;
}
