import type { ApprovalRequest, CostsRead, FactoryEvent, QueueSnapshot } from '@on-par/factory-core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeFakeFollow() {
  let onEvent: ((e: FactoryEvent) => void) | undefined;
  const stop = vi.fn();
  const follow = vi.fn((_file: string, cb: (e: FactoryEvent) => void) => {
    onEvent = cb;
    return stop;
  });
  return {
    follow,
    stop,
    push: (e: FactoryEvent) => onEvent?.(e),
  };
}

function ev(type: string, msg: string, issue = '192', ts = new Date().toISOString()): FactoryEvent {
  return { ts, type, issue, msg };
}

/** Ink schedules re-renders on a microtask; flush it before reading lastFrame(). */
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

describe('App', () => {
  it('shows a waiting message before any events arrive', () => {
    const { follow } = makeFakeFollow();
    const { lastFrame } = render(<App eventsFile="ignored" follow={follow} />);
    expect(lastFrame()).toContain('waiting for factory events');
  });

  it('renders a single lane directly in detail view with no row list', async () => {
    const fake = makeFakeFollow();
    const { lastFrame } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('router', 'Trying claude-sonnet for plan (attempt 1)', '296'));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('#296');
    expect(frame).toContain('PLAN');
    expect(frame).toContain('claude-sonnet');
    expect(frame).not.toContain('lane(s)');
  });

  it('renders independent rows for multiple lanes that update independently', async () => {
    const fake = makeFakeFollow();
    const { lastFrame } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('plan', 'Starting plan phase', '301'));
    fake.push(ev('build', 'Starting build phase (route: claude)', '301'));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('2 lane(s)');
    expect(frame).toContain('#296');
    expect(frame).toContain('#301');
  });

  it('drills into the selected lane on down-arrow then Enter, and Escape returns to the dashboard', async () => {
    const fake = makeFakeFollow();
    const { lastFrame, stdin } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('plan', 'Starting plan phase', '301'));
    fake.push(ev('router', 'Trying gpt-5 for plan (attempt 1)', '301'));
    await flush();

    stdin.write('[B'); // down arrow
    await flush();
    stdin.write('\r'); // enter
    await flush();

    const detailFrame = lastFrame() ?? '';
    expect(detailFrame).toContain('#301');
    expect(detailFrame).toContain('gpt-5');
    expect(detailFrame).toContain('esc back · q quit');

    stdin.write(''); // escape
    await flush();

    const dashboardFrame = lastFrame() ?? '';
    expect(dashboardFrame).toContain('2 lane(s)');
  });

  it('stops following when the user presses q from the dashboard or detail view', async () => {
    const fake = makeFakeFollow();
    const { stdin } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('plan', 'Starting plan phase', '301'));
    await flush();

    stdin.write('\r'); // enter detail view
    await flush();
    stdin.write('q');
    await flush();

    expect(fake.stop).toHaveBeenCalled();
  });

  it('shows the STOP banner once the poll observes the stop file, without disturbing lane rows', async () => {
    vi.useFakeTimers();
    const fake = makeFakeFollow();
    const pathExists = vi.fn(() => true);
    const { lastFrame } = render(
      <App eventsFile="ignored" follow={fake.follow} stopFile="/repo/.factory/STOP" pathExists={pathExists} />,
    );

    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('plan', 'Starting plan phase', '301'));
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1600);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('FACTORY STOPPED');
    expect(frame).toContain('#296');
    expect(frame).toContain('#301');
  });

  it('shows the STOP banner with the usage cap message when a usage-stop event is observed', async () => {
    const fake = makeFakeFollow();
    const { lastFrame } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('plan', 'Starting plan phase', '301'));
    fake.push(ev('usage-stop', 'daily usage cap reached', 'usage'));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('FACTORY STOPPED');
    expect(frame).toContain('daily usage cap reached');
  });

  it('cycles Dashboard -> Queue -> Costs -> Log -> Dashboard on Tab, and jumps directly on digit keys', async () => {
    const fake = makeFakeFollow();
    const { lastFrame, stdin } = render(<App eventsFile="ignored" follow={fake.follow} />);

    stdin.write('\t');
    await flush();
    expect(lastFrame()).toContain('[2 Queue]');

    stdin.write('\t');
    await flush();
    expect(lastFrame()).toContain('[3 Costs]');

    stdin.write('\t');
    await flush();
    expect(lastFrame()).toContain('[4 Log]');

    stdin.write('\t');
    await flush();
    expect(lastFrame()).toContain('[1 Dashboard]');

    stdin.write('2');
    await flush();
    expect(lastFrame()).toContain('[2 Queue]');
  });

  it('shows Queue tab entries with titles joined from issue-title events', async () => {
    const fake = makeFakeFollow();
    const queueSnap: QueueSnapshot = { entries: [{ lane: 'app', issue: 296 }] };
    const readQueueFn = vi.fn(() => queueSnap);
    const { lastFrame, stdin } = render(
      <App eventsFile="ignored" follow={fake.follow} queueFile="/repo/.factory/queue" readQueueFn={readQueueFn} />,
    );

    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('issue-title', 'Fix the flaky test', '296'));
    await flush();

    stdin.write('2');
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('#296');
    expect(frame).toContain('running');
    expect(frame).toContain('Fix the flaky test');
  });

  it('shows Costs tab totals and the skipped-line warning without crashing', async () => {
    const fake = makeFakeFollow();
    const costsRead: CostsRead = {
      entries: [
        {
          ts: 't1',
          issue: '296',
          task: 'build',
          model: 'claude-sonnet-5',
          inputTokens: 100,
          outputTokens: 50,
          cost: 0.01,
        },
      ],
      skipped: 1,
    };
    const readCostsFn = vi.fn(() => costsRead);
    const { lastFrame, stdin } = render(
      <App
        eventsFile="ignored"
        follow={fake.follow}
        costsFile="/repo/.factory/costs.jsonl"
        readCostsFn={readCostsFn}
      />,
    );

    stdin.write('3');
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('#296');
    expect(frame).toContain('⚠ skipped 1 malformed line(s) in costs.jsonl');
    expect(frame).toContain('session total');
  });

  it('scrolls the Log tab with the up arrow and re-enables follow with f', async () => {
    const fake = makeFakeFollow();
    const { lastFrame, stdin } = render(<App eventsFile="ignored" follow={fake.follow} />);

    for (let i = 0; i < 30; i++) {
      fake.push(ev('build', `step ${i}`, '296', `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`));
    }
    await flush();

    stdin.write('4');
    await flush();
    await flush(); // extra tick: let useInput's effect resubscribe with the updated tab before the next keypress
    let frame = lastFrame() ?? '';
    expect(frame).toContain('step 29');
    expect(frame).toContain('follow: on');

    stdin.write('\x1B[A'); // up arrow
    await flush();
    await flush();
    frame = lastFrame() ?? '';
    expect(frame).toContain('follow: off');
    expect(frame).not.toContain('step 29');

    stdin.write('f');
    await flush();
    await flush();
    frame = lastFrame() ?? '';
    expect(frame).toContain('follow: on');
    expect(frame).toContain('step 29');
  });

  it('keeps dashboard keys (up/down/enter/escape) scoped to the dashboard tab', async () => {
    const fake = makeFakeFollow();
    const { lastFrame, stdin } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('plan', 'Starting plan phase', '301'));
    await flush();

    stdin.write('4'); // switch to Log tab
    await flush();
    await flush(); // extra tick: let useInput's effect resubscribe with the updated tab before the next keypress
    stdin.write('\x1B[B'); // down arrow -- should scroll the log, not select a dashboard lane
    await flush();
    stdin.write('\r'); // enter -- should do nothing on the Log tab
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('esc back · q quit');
    expect(frame).toContain('follow: on'); // down arrow while already at the tail is a no-op, log stays on follow

    stdin.write('1'); // back to Dashboard tab
    await flush();
    expect(lastFrame()).toContain('2 lane(s)');
  });

  it('resets a stale dashboard drill-down when leaving and returning to the Dashboard tab', async () => {
    const fake = makeFakeFollow();
    const { lastFrame, stdin } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('plan', 'Starting plan phase', '301'));
    await flush();

    stdin.write('\x1B[B'); // down arrow to select the second lane
    await flush();
    stdin.write('\r'); // enter drill-down view
    await flush();
    expect(lastFrame() ?? '').toContain('esc back · q quit');

    stdin.write('2'); // switch away to the Queue tab (without pressing escape first)
    await flush();
    stdin.write('1'); // back to the Dashboard tab
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('2 lane(s)');
    expect(frame).not.toContain('esc back · q quit');
  });
});

describe('App approvals', () => {
  function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
    return {
      id: 'req-1',
      issue: 296,
      branch: 'ship-it/296-thing',
      worktree: '/repo-296',
      diffStat: ' file.ts | 2 ++\n',
      requestedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('renders the approval prompt on the dashboard tab and after switching tabs', async () => {
    const fake = makeFakeFollow();
    const listPendingFn = vi.fn(() => [makeRequest()]);
    const respondFn = vi.fn();
    const { lastFrame, stdin } = render(
      <App
        eventsFile="ignored"
        follow={fake.follow}
        approvalsDir="/repo/.factory/approvals"
        listPendingFn={listPendingFn}
        respondFn={respondFn}
      />,
    );
    await flush();

    expect(lastFrame()).toContain('APPROVAL REQUIRED');

    stdin.write('\t'); // switch to Queue tab
    await flush();
    expect(lastFrame()).toContain('APPROVAL REQUIRED');
  });

  it('approves with y and the prompt disappears from the frame', async () => {
    const fake = makeFakeFollow();
    const listPendingFn = vi.fn(() => [makeRequest()]);
    const respondFn = vi.fn();
    const { lastFrame, stdin } = render(
      <App
        eventsFile="ignored"
        follow={fake.follow}
        approvalsDir="/repo/.factory/approvals"
        listPendingFn={listPendingFn}
        respondFn={respondFn}
      />,
    );
    await flush();

    stdin.write('y');
    await flush();

    expect(respondFn).toHaveBeenCalledWith('/repo/.factory/approvals', 'req-1', { approved: true });
    expect(lastFrame()).not.toContain('APPROVAL REQUIRED');
  });

  it('denies with n then a typed reason then Enter, and q does not exit while typing', async () => {
    const fake = makeFakeFollow();
    const listPendingFn = vi.fn(() => [makeRequest()]);
    const respondFn = vi.fn();
    const { lastFrame, stdin } = render(
      <App
        eventsFile="ignored"
        follow={fake.follow}
        approvalsDir="/repo/.factory/approvals"
        listPendingFn={listPendingFn}
        respondFn={respondFn}
      />,
    );
    await flush();

    stdin.write('n');
    await flush();
    await flush(); // extra tick: let useInput's effect resubscribe with the updated deny-mode state
    expect(lastFrame()).toContain('deny reason');

    stdin.write('nope');
    await flush();
    await flush();
    expect(lastFrame()).toContain('nope');
    expect(respondFn).not.toHaveBeenCalled();

    stdin.write('q');
    await flush();
    await flush();
    expect(lastFrame()).toContain('nopeq');

    stdin.write('\r');
    await flush();

    expect(respondFn).toHaveBeenCalledWith('/repo/.factory/approvals', 'req-1', { approved: false, reason: 'nopeq' });
    expect(lastFrame()).not.toContain('APPROVAL REQUIRED');
  });

  it('cancels deny mode with Escape without calling respondFn', async () => {
    const fake = makeFakeFollow();
    const listPendingFn = vi.fn(() => [makeRequest()]);
    const respondFn = vi.fn();
    const { lastFrame, stdin } = render(
      <App
        eventsFile="ignored"
        follow={fake.follow}
        approvalsDir="/repo/.factory/approvals"
        listPendingFn={listPendingFn}
        respondFn={respondFn}
      />,
    );
    await flush();

    stdin.write('n');
    await flush();
    expect(lastFrame()).toContain('deny reason');

    stdin.write('\x1B'); // escape
    await flush();

    expect(lastFrame()).toContain('y approve · n deny');
    expect(respondFn).not.toHaveBeenCalled();
  });
});

describe('App steering composer', () => {
  it('opens the composer for the active lane on "i"', async () => {
    const fake = makeFakeFollow();
    const { lastFrame, stdin } = render(
      <App eventsFile="ignored" follow={fake.follow} steeringDir="/repo/.factory/steering" />,
    );
    fake.push(ev('plan', 'Starting plan phase', '296'));
    await flush();

    stdin.write('i');
    await flush();

    expect(lastFrame()).toContain('Steer issue #296');
    expect(lastFrame()).toContain('Enter send · Esc cancel');
  });

  it('does not open the composer when steeringDir is unset', async () => {
    const fake = makeFakeFollow();
    const { lastFrame, stdin } = render(<App eventsFile="ignored" follow={fake.follow} />);
    fake.push(ev('plan', 'Starting plan phase', '296'));
    await flush();

    stdin.write('i');
    await flush();

    expect(lastFrame()).not.toContain('Steer issue #296');
  });

  it('does not open the composer over a pending approval, and leaves y/n handling intact', async () => {
    const fake = makeFakeFollow();
    const listPendingFn = vi.fn(() => [
      {
        id: 'req-1',
        issue: 296,
        branch: 'ship-it/296-thing',
        worktree: '/repo-296',
        diffStat: '',
        requestedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const respondFn = vi.fn();
    const { lastFrame, stdin } = render(
      <App
        eventsFile="ignored"
        follow={fake.follow}
        steeringDir="/repo/.factory/steering"
        approvalsDir="/repo/.factory/approvals"
        listPendingFn={listPendingFn}
        respondFn={respondFn}
      />,
    );
    fake.push(ev('plan', 'Starting plan phase', '296'));
    await flush();

    stdin.write('i');
    await flush();

    expect(lastFrame()).not.toContain('Steer issue #296');
    expect(lastFrame()).toContain('APPROVAL REQUIRED');

    stdin.write('y');
    await flush();

    expect(respondFn).toHaveBeenCalledWith('/repo/.factory/approvals', 'req-1', { approved: true });
  });

  it('types text then Enter queues the message and closes the composer', async () => {
    const fake = makeFakeFollow();
    const queueSteeringFn = vi.fn();
    const { lastFrame, stdin } = render(
      <App
        eventsFile="ignored"
        follow={fake.follow}
        steeringDir="/repo/.factory/steering"
        queueSteeringFn={queueSteeringFn}
      />,
    );
    fake.push(ev('plan', 'Starting plan phase', '296'));
    await flush();

    stdin.write('i');
    await flush();
    stdin.write('hello there');
    await flush();
    await flush(); // extra tick: let useInput's effect resubscribe with the updated draft before Enter
    stdin.write('\r');
    await flush();

    expect(queueSteeringFn).toHaveBeenCalledWith('/repo/.factory/steering', 296, 'hello there');
    expect(lastFrame()).not.toContain('Steer issue #296');
  });

  it('Escape closes the composer without sending', async () => {
    const fake = makeFakeFollow();
    const queueSteeringFn = vi.fn();
    const { lastFrame, stdin } = render(
      <App
        eventsFile="ignored"
        follow={fake.follow}
        steeringDir="/repo/.factory/steering"
        queueSteeringFn={queueSteeringFn}
      />,
    );
    fake.push(ev('plan', 'Starting plan phase', '296'));
    await flush();

    stdin.write('i');
    await flush();
    stdin.write('some text');
    await flush();
    stdin.write('\x1B'); // escape
    await flush();

    expect(queueSteeringFn).not.toHaveBeenCalled();
    expect(lastFrame()).not.toContain('Steer issue #296');
  });

  it('lands a multi-line paste into one draft and sends it as a single message', async () => {
    const fake = makeFakeFollow();
    const queueSteeringFn = vi.fn();
    const { stdin } = render(
      <App
        eventsFile="ignored"
        follow={fake.follow}
        steeringDir="/repo/.factory/steering"
        queueSteeringFn={queueSteeringFn}
      />,
    );
    fake.push(ev('plan', 'Starting plan phase', '296'));
    await flush();

    stdin.write('i');
    await flush();
    stdin.write('use a\nand b\n plus packages/x.ts');
    await flush();
    await flush(); // extra tick: let useInput's effect resubscribe with the updated draft before Enter
    stdin.write('\r');
    await flush();

    expect(queueSteeringFn).toHaveBeenCalledTimes(1);
    expect(queueSteeringFn).toHaveBeenCalledWith('/repo/.factory/steering', 296, 'use a\nand b\n plus packages/x.ts');
  });

  it('shows a warning on the first Enter when a referenced path is missing, and sends on the second Enter', async () => {
    const fake = makeFakeFollow();
    const queueSteeringFn = vi.fn();
    const pathExists = vi.fn(() => false);
    const { lastFrame, stdin } = render(
      <App
        eventsFile="ignored"
        follow={fake.follow}
        steeringDir="/repo/.factory/steering"
        queueSteeringFn={queueSteeringFn}
        pathExists={pathExists}
      />,
    );
    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('worktree', 'Worktree ready at /repo-296', '296'));
    await flush();

    stdin.write('i');
    await flush();
    stdin.write('check packages/missing.ts');
    await flush();
    await flush(); // extra tick: let useInput's effect resubscribe with the updated draft before Enter
    stdin.write('\r');
    await flush();

    expect(queueSteeringFn).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('not found in worktree: packages/missing.ts');

    await flush(); // extra tick: let useInput's effect resubscribe with the warned state before the next Enter
    stdin.write('\r');
    await flush();

    expect(queueSteeringFn).toHaveBeenCalledWith('/repo/.factory/steering', 296, 'check packages/missing.ts');
  });

  it('sends on the first Enter when the referenced path exists', async () => {
    const fake = makeFakeFollow();
    const queueSteeringFn = vi.fn();
    const pathExists = vi.fn(() => true);
    const { lastFrame, stdin } = render(
      <App
        eventsFile="ignored"
        follow={fake.follow}
        steeringDir="/repo/.factory/steering"
        queueSteeringFn={queueSteeringFn}
        pathExists={pathExists}
      />,
    );
    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('worktree', 'Worktree ready at /repo-296', '296'));
    await flush();

    stdin.write('i');
    await flush();
    stdin.write('check packages/present.ts');
    await flush();
    await flush(); // extra tick: let useInput's effect resubscribe with the updated draft before Enter
    stdin.write('\r');
    await flush();

    expect(queueSteeringFn).toHaveBeenCalledWith('/repo/.factory/steering', 296, 'check packages/present.ts');
    expect(lastFrame()).not.toContain('Steer issue #296');
  });

  it('renders the queued-for-next-phase-boundary count when listSteeringFn returns entries', async () => {
    const fake = makeFakeFollow();
    const listSteeringFn = vi.fn(() => [
      { id: '1', issue: 296, text: 'a', queuedAt: '2026-01-01T00:00:00.000Z' },
      { id: '2', issue: 296, text: 'b', queuedAt: '2026-01-01T00:00:01.000Z' },
    ]);
    const { lastFrame } = render(
      <App
        eventsFile="ignored"
        follow={fake.follow}
        steeringDir="/repo/.factory/steering"
        listSteeringFn={listSteeringFn}
      />,
    );
    fake.push(ev('plan', 'Starting plan phase', '296'));
    await flush();
    await flush(); // extra tick: let the steering-poll effect re-run now that state.lanes is populated

    expect(lastFrame()).toContain('steering: 2 message(s) queued for next phase boundary');
  });

  it('keeps navigation keys (q, tab, digits) inert while the composer is open', async () => {
    const fake = makeFakeFollow();
    const { lastFrame, stdin } = render(
      <App eventsFile="ignored" follow={fake.follow} steeringDir="/repo/.factory/steering" />,
    );
    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('plan', 'Starting plan phase', '301'));
    await flush();

    stdin.write('i');
    await flush();

    stdin.write('q');
    await flush();
    stdin.write('\t');
    await flush();
    stdin.write('2');
    await flush();

    expect(fake.stop).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Steer issue #');
  });
});
