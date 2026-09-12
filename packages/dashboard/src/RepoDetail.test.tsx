// @vitest-environment jsdom
import type { RepositoryLaneLifecycleEvent } from '@on-par/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { emptyLaneBoard } from './laneBoardState.js';
import { RepoDetail } from './RepoDetail.js';
import { reduceRepoLaneEvent } from './repoDetailState.js';

afterEach(cleanup);

const baseEvent: RepositoryLaneLifecycleEvent = {
  ts: '2026-08-19T00:00:00.000Z',
  laneId: 'lane-1',
  issueId: '1384',
  phase: 'plan',
  status: 'started',
  detail: 'planning',
  worktreePath: '/tmp/lane-1',
  repo: 'a/one',
};

describe('RepoDetail', () => {
  it('renders the region, repo heading, and back link', () => {
    render(<RepoDetail repo="a/one" board={emptyLaneBoard()} connection="connecting" />);

    const region = screen.getByRole('region', { name: 'Repo detail a/one' });
    expect(within(region).getByText('a/one')).toBeDefined();
    expect(screen.getByRole('link', { name: '← All repos' })).toBeDefined();
  });

  it('shows the empty state and no log tail when there are no lanes', () => {
    render(<RepoDetail repo="a/one" board={emptyLaneBoard()} connection="connecting" />);

    expect(screen.getByText('No lanes for a/one yet…')).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Log tail' })).toBeNull();
  });

  it('bounds the log tail to 8 entries for a lane fed 12 events', () => {
    let board = emptyLaneBoard();
    for (let i = 0; i < 12; i++) {
      board = reduceRepoLaneEvent(board, 'a/one', {
        ...baseEvent,
        status: 'progress',
        detail: `step ${i}`,
      });
    }
    render(<RepoDetail repo="a/one" board={board} connection="live" />);

    const region = screen.getByRole('region', { name: 'Repo detail a/one' });
    const logTail = within(region).getByRole('list', { name: 'Log tail' });
    const items = within(logTail).getAllByRole('listitem');
    expect(items).toHaveLength(8);
    expect(items.at(-1)?.textContent).toContain('step 11');
  });

  it('renders the Live chip for a live connection', () => {
    render(<RepoDetail repo="a/one" board={emptyLaneBoard()} connection="live" />);
    expect(screen.getByRole('status').textContent).toBe('Live');
  });

  it('renders the Disconnected chip for a disconnected connection', () => {
    render(<RepoDetail repo="a/one" board={emptyLaneBoard()} connection="disconnected" />);
    expect(screen.getByRole('status').textContent).toBe('Disconnected');
  });
});
