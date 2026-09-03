import { describe, expect, it } from 'vitest';

import { renderRepoLane } from './repo-lane.js';

describe('renderRepoLane', () => {
  it('renders the canonical owner/name#laneId form', () => {
    expect(renderRepoLane('on-par/sound-buddy', 'lane-2')).toBe('on-par/sound-buddy#lane-2');
  });

  it('renders a second representative repo/lane pair', () => {
    expect(renderRepoLane('octocat/hello-world', 'lane-17')).toBe('octocat/hello-world#lane-17');
  });

  it('preserves owner/name and lane ids containing dots, dashes, and underscores', () => {
    expect(renderRepoLane('my-org/my.repo_name', 'feat_x-1')).toBe('my-org/my.repo_name#feat_x-1');
  });
});
