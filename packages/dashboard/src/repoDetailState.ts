import type { RepositoryLaneLifecycleEvent } from '@on-par/contracts';

import { reduceLaneEvent, type LaneBoardState } from './laneBoardState.js';

export const DEFAULT_EVENTS_URL = '/events';

/** Reads the `repo` query param, trimming and treating an absent or blank value as unselected. */
export function repoFromLocation(search: string): string | null {
  const params = new URLSearchParams(search);
  const repo = params.get('repo');
  if (repo === null) return null;
  const trimmed = repo.trim();
  return trimmed === '' ? null : trimmed;
}

export function repoEventsUrl(repo: string, baseUrl: string = DEFAULT_EVENTS_URL): string {
  return `${baseUrl}?repo=${encodeURIComponent(repo)}`;
}

/** Folds a repo-tagged frame into board state only when it matches the selected repo; a
 * non-matching frame returns the identical state reference so React does not re-render. */
export function reduceRepoLaneEvent(
  state: LaneBoardState,
  repo: string,
  event: RepositoryLaneLifecycleEvent,
): LaneBoardState {
  if (event.repo !== repo) return state;
  return reduceLaneEvent(state, event);
}
