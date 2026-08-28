import type { render } from 'ink';
import type { ReactElement, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { AppProps } from './components/App.js';
import { runTui } from './run-tui.js';

/** runTui only reads stdout.isTTY and forwards stdout to followPlainFn; one assertion is enough. */
function fakeStdout(isTTY: boolean): NodeJS.WriteStream {
  return { isTTY } as NodeJS.WriteStream;
}

/** runTui renders exactly one element and it is always <App/>; ink's `render` types its tree as
 *  the broader ReactNode, so one assertion narrows it to the concrete element the call site
 *  passed, recovering its AppProps directly (deviates from the frozen plan's `ReactElement`
 *  parameter, which does not match ink's actual `render(node: ReactNode, ...)` signature). */
function appPropsOf(node: ReactNode): AppProps {
  return (node as ReactElement<AppProps>).props;
}

describe('runTui', () => {
  it('falls back to plain printing on a non-TTY stdout, without invoking render', async () => {
    const stdout = fakeStdout(false);
    const stop = vi.fn();
    const followPlainFn = vi.fn(() => stop);
    const renderFn = vi.fn();

    const promise = runTui({ eventsFile: 'events.ndjson', stdout, render: renderFn, followPlainFn });
    process.emit('SIGINT', 'SIGINT');
    await expect(promise).resolves.toBeUndefined();

    expect(followPlainFn).toHaveBeenCalledWith('events.ndjson', stdout);
    expect(renderFn).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  it('falls back to plain printing when render throws', async () => {
    const stdout = fakeStdout(true);
    const stop = vi.fn();
    const followPlainFn = vi.fn(() => stop);
    const renderFn = vi.fn(() => {
      throw new Error('ink init failed');
    });

    const promise = runTui({ eventsFile: 'events.ndjson', stdout, render: renderFn, followPlainFn });
    process.emit('SIGINT', 'SIGINT');
    await expect(promise).resolves.toBeUndefined();

    expect(renderFn).toHaveBeenCalled();
    expect(followPlainFn).toHaveBeenCalledWith('events.ndjson', stdout);
  });

  it('resolves via the Ink app exiting on a TTY stdout', async () => {
    const stdout = fakeStdout(true);
    const waitUntilExit = vi.fn().mockResolvedValue(undefined);
    const renderFn = vi.fn<typeof render>(() => ({
      rerender: vi.fn(),
      unmount: vi.fn(),
      waitUntilExit,
      cleanup: vi.fn(),
      clear: vi.fn(),
    }));
    const followPlainFn = vi.fn(() => vi.fn());

    await expect(
      runTui({ eventsFile: 'events.ndjson', stdout, render: renderFn, followPlainFn }),
    ).resolves.toBeUndefined();

    expect(renderFn).toHaveBeenCalled();
    expect(waitUntilExit).toHaveBeenCalled();
    expect(followPlainFn).not.toHaveBeenCalled();
  });

  it('forwards stopFile through to the rendered App', async () => {
    const stdout = fakeStdout(true);
    const waitUntilExit = vi.fn().mockResolvedValue(undefined);
    const renderFn = vi.fn<typeof render>(() => ({
      rerender: vi.fn(),
      unmount: vi.fn(),
      waitUntilExit,
      cleanup: vi.fn(),
      clear: vi.fn(),
    }));
    const followPlainFn = vi.fn(() => vi.fn());

    await runTui({
      eventsFile: 'events.ndjson',
      stopFile: '/repo/.factory/STOP',
      stdout,
      render: renderFn,
      followPlainFn,
    });

    expect(renderFn).toHaveBeenCalled();
    const call = renderFn.mock.calls[0];
    expect(call).toBeDefined();
    expect(appPropsOf(call?.[0]).stopFile).toBe('/repo/.factory/STOP');
  });

  it('forwards queueFile, queueProposedFile, and costsFile through to the rendered App', async () => {
    const stdout = fakeStdout(true);
    const waitUntilExit = vi.fn().mockResolvedValue(undefined);
    const renderFn = vi.fn<typeof render>(() => ({
      rerender: vi.fn(),
      unmount: vi.fn(),
      waitUntilExit,
      cleanup: vi.fn(),
      clear: vi.fn(),
    }));
    const followPlainFn = vi.fn(() => vi.fn());

    await runTui({
      eventsFile: 'events.ndjson',
      queueFile: '/repo/.factory/queue',
      queueProposedFile: '/repo/.factory/queue.proposed',
      costsFile: '/repo/.factory/costs.jsonl',
      stdout,
      render: renderFn,
      followPlainFn,
    });

    const call = renderFn.mock.calls[0];
    expect(call).toBeDefined();
    const props = appPropsOf(call?.[0]);
    expect(props.queueFile).toBe('/repo/.factory/queue');
    expect(props.queueProposedFile).toBe('/repo/.factory/queue.proposed');
    expect(props.costsFile).toBe('/repo/.factory/costs.jsonl');
  });

  it('forwards approvalsDir through to the rendered App', async () => {
    const stdout = fakeStdout(true);
    const waitUntilExit = vi.fn().mockResolvedValue(undefined);
    const renderFn = vi.fn<typeof render>(() => ({
      rerender: vi.fn(),
      unmount: vi.fn(),
      waitUntilExit,
      cleanup: vi.fn(),
      clear: vi.fn(),
    }));
    const followPlainFn = vi.fn(() => vi.fn());

    await runTui({
      eventsFile: 'events.ndjson',
      approvalsDir: '/repo/.factory/approvals',
      stdout,
      render: renderFn,
      followPlainFn,
    });

    const call = renderFn.mock.calls[0];
    expect(call).toBeDefined();
    expect(appPropsOf(call?.[0]).approvalsDir).toBe('/repo/.factory/approvals');
  });

  it('forwards steeringDir through to the rendered App', async () => {
    const stdout = fakeStdout(true);
    const waitUntilExit = vi.fn().mockResolvedValue(undefined);
    const renderFn = vi.fn<typeof render>(() => ({
      rerender: vi.fn(),
      unmount: vi.fn(),
      waitUntilExit,
      cleanup: vi.fn(),
      clear: vi.fn(),
    }));
    const followPlainFn = vi.fn(() => vi.fn());

    await runTui({
      eventsFile: 'events.ndjson',
      steeringDir: '/repo/.factory/steering',
      stdout,
      render: renderFn,
      followPlainFn,
    });

    const call = renderFn.mock.calls[0];
    expect(call).toBeDefined();
    expect(appPropsOf(call?.[0]).steeringDir).toBe('/repo/.factory/steering');
  });
});
