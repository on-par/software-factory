// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LaneBoard } from './LaneBoard.js';
import { emptyLaneBoard, reduceLaneEvent, type LaneBoardState } from './laneBoardState.js';
import { STALE_AFTER_MS } from './laneProgress.js';

afterEach(cleanup);

const T0 = Date.parse('2026-08-19T00:00:00.000Z');

function boardWithLane(overrides: Record<string, unknown> = {}): LaneBoardState {
  return reduceLaneEvent(emptyLaneBoard(), {
    ts: '2026-08-19T00:00:00.000Z',
    laneId: 'lane-1',
    issueId: '593',
    phase: 'build',
    status: 'started',
    detail: 'building',
    worktreePath: '/tmp/lane-1',
    ...overrides,
  });
}

describe('LaneBoard', () => {
  it('renders "Waiting for lane events…" and no article when the board is empty', () => {
    render(<LaneBoard board={emptyLaneBoard()} connection="connecting" now={T0} />);
    expect(screen.getByText('Waiting for lane events…')).toBeDefined();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('renders one card per lane, found by label', () => {
    const board = boardWithLane();
    render(<LaneBoard board={board} connection="live" now={T0} />);
    expect(screen.getByLabelText('Lane lane-1')).toBeDefined();
  });

  it('renders exactly four stepper segments in plan/build/check/ship order', () => {
    const board = boardWithLane();
    render(<LaneBoard board={board} connection="live" now={T0} />);
    const stepper = screen.getByRole('list', { name: 'Pipeline progress' });
    const items = within(stepper).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.textContent?.slice(0, 5))).toEqual(['plan', 'build', 'check', 'ship']);
  });

  it('marks the active phase list item with aria-current="step"', () => {
    const board = boardWithLane({ phase: 'build', status: 'started' });
    render(<LaneBoard board={board} connection="live" now={T0} />);
    const stepper = screen.getByRole('list', { name: 'Pipeline progress' });
    const items = within(stepper).getAllByRole('listitem');
    expect(items[1]?.getAttribute('aria-current')).toBe('step');
    expect(items[0]?.getAttribute('aria-current')).toBeNull();
    expect(items[2]?.getAttribute('aria-current')).toBeNull();
    expect(items[3]?.getAttribute('aria-current')).toBeNull();
  });

  it('applies the expected bar class for each segment state', () => {
    let board = boardWithLane({ phase: 'plan', status: 'done' });
    board = reduceLaneEvent(board, {
      ts: '2026-08-19T00:01:00.000Z',
      laneId: 'lane-1',
      issueId: '593',
      phase: 'build',
      status: 'started',
      detail: 'building',
      worktreePath: '/tmp/lane-1',
    });
    board = reduceLaneEvent(board, {
      ts: '2026-08-19T00:02:00.000Z',
      laneId: 'lane-1',
      issueId: '593',
      phase: 'check',
      status: 'failed',
      detail: 'check failed',
      worktreePath: '/tmp/lane-1',
    });

    render(<LaneBoard board={board} connection="live" now={T0 + 2 * 60_000} />);
    const stepper = screen.getByRole('list', { name: 'Pipeline progress' });

    expect(within(stepper).getByLabelText('plan done').className).toContain('bg-status-shipped');
    expect(within(stepper).getByLabelText('build active').className).toContain('bg-status-building');
    expect(within(stepper).getByLabelText('check failed').className).toContain('bg-status-failed');
    expect(within(stepper).getByLabelText('ship pending').className).toContain('bg-hairline');
  });

  it('shows a per-phase elapsed label for each started phase', () => {
    let board = boardWithLane({ phase: 'plan', status: 'done' });
    board = reduceLaneEvent(board, {
      ts: '2026-08-19T00:01:00.000Z',
      laneId: 'lane-1',
      issueId: '593',
      phase: 'build',
      status: 'started',
      detail: 'building',
      worktreePath: '/tmp/lane-1',
    });

    render(<LaneBoard board={board} connection="live" now={T0 + 2 * 60_000} />);
    expect(screen.getByLabelText('plan elapsed')).toBeDefined();
    expect(screen.getByLabelText('build elapsed')).toBeDefined();
    expect(screen.queryByLabelText('check elapsed')).toBeNull();
  });

  it('renders the chip text from laneProgress, and a failed card carries the failed chip class', () => {
    const board = boardWithLane({ phase: 'check', status: 'failed' });
    render(<LaneBoard board={board} connection="live" now={T0} />);
    const chip = screen.getByLabelText('Lane lane-1').querySelector('[role="status"]');
    expect(chip?.textContent).toBe('failed');
    expect(chip?.className).toContain('bg-status-failed');
  });

  it('AC 1: a waiting-merge lane with a fresh heartbeat shows the chip and elapsed, and is never stale', () => {
    const board = boardWithLane({ status: 'progress', laneState: 'waiting-merge' });
    render(<LaneBoard board={board} connection="live" now={T0 + 10_000} />);
    const chip = screen.getByLabelText('Lane lane-1').querySelector('[role="status"]');
    expect(chip?.textContent).toBe('waiting-merge');
    expect(screen.getByLabelText('Lane elapsed')).toBeDefined();
    expect(screen.queryByText('stale')).toBeNull();
  });

  it('AC 1: the same waiting-merge lane goes stale once 20 minutes pass', () => {
    const board = boardWithLane({ status: 'progress', laneState: 'waiting-merge' });
    render(<LaneBoard board={board} connection="live" now={T0 + STALE_AFTER_MS + 5 * 60_000} />);
    const chip = screen.getByLabelText('Lane lane-1').querySelector('[role="status"]');
    expect(chip?.textContent).toBe('stale');
  });

  it('AC 2: a parked lane renders an alert with the detail text and a worktree link', () => {
    const board = boardWithLane({
      status: 'progress',
      laneState: 'parked',
      detail: 'blocked on manual review',
      worktreePath: '/tmp/lane-parked',
    });
    render(<LaneBoard board={board} connection="live" now={T0} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('blocked on manual review');
    const link = within(alert).getByRole('link');
    expect(link.getAttribute('href')).toContain('/tmp/lane-parked');
  });

  it('lists the log tail lines in order', () => {
    let board = boardWithLane({ detail: 'first' });
    board = reduceLaneEvent(board, {
      ts: '2026-08-19T00:01:00.000Z',
      laneId: 'lane-1',
      issueId: '593',
      phase: 'build',
      status: 'progress',
      detail: 'second',
      worktreePath: '/tmp/lane-1',
    });

    render(<LaneBoard board={board} connection="live" now={T0} />);
    const log = screen.getByRole('list', { name: 'Log tail' });
    const lines = within(log).getAllByRole('listitem');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.textContent).toContain('first');
    expect(lines[1]?.textContent).toContain('second');
  });

  it('applies responsive grid classes to the card container', () => {
    const board = boardWithLane();
    render(<LaneBoard board={board} connection="live" now={T0} />);
    const grid = screen.getByLabelText('Lane lane-1').closest('ul');
    expect(grid?.className).toContain('grid-cols-1');
    expect(grid?.className).toContain('sm:grid-cols-2');
  });

  it.each([
    ['connecting', 'Connecting…'],
    ['live', 'Live'],
    ['disconnected', 'Disconnected'],
  ] as const)('shows the connection chip text for %s', (connection, expectedText) => {
    const board = boardWithLane();
    render(<LaneBoard board={board} connection={connection} now={T0} />);
    expect(screen.getByText(expectedText)).toBeDefined();
  });
});
