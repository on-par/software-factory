import { describe, expect, it } from 'vitest';

import { type RepoRouteFailureReason, repoFailureStatus } from './repo-route-status.js';

describe('repoFailureStatus', () => {
  const table: Record<RepoRouteFailureReason, 400 | 404 | 409> = {
    'invalid-request': 400,
    'not-a-git-checkout': 400,
    'origin-mismatch': 400,
    'missing-factory-config': 400,
    'unknown-repo': 404,
    draining: 409,
    detached: 409,
    'state-root-mismatch': 409,
  };

  it.each(Object.entries(table))('maps %s to %i', (reason, status) => {
    expect(repoFailureStatus(reason as RepoRouteFailureReason)).toBe(status);
  });
});
