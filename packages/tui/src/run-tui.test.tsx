import { describe, expect, it, vi } from 'vitest';

import { runTui } from './run-tui.js';

function fakeStdout(isTTY: boolean): NodeJS.WriteStream {
  return { isTTY } as unknown as NodeJS.WriteStream;
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
    const renderFn = vi.fn(() => ({
      rerender: vi.fn(),
      unmount: vi.fn(),
      waitUntilExit,
      cleanup: vi.fn(),
      clear: vi.fn(),
    }));
    const followPlainFn = vi.fn(() => vi.fn());

    await expect(
      runTui({ eventsFile: 'events.ndjson', stdout, render: renderFn as any, followPlainFn }),
    ).resolves.toBeUndefined();

    expect(renderFn).toHaveBeenCalled();
    expect(waitUntilExit).toHaveBeenCalled();
    expect(followPlainFn).not.toHaveBeenCalled();
  });

  it('forwards stopFile through to the rendered App', async () => {
    const stdout = fakeStdout(true);
    const waitUntilExit = vi.fn().mockResolvedValue(undefined);
    const renderFn = vi.fn(() => ({
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
      render: renderFn as any,
      followPlainFn,
    });

    expect(renderFn).toHaveBeenCalled();
    const [element] = renderFn.mock.calls[0] as unknown as [any, any];
    expect(element.props.stopFile).toBe('/repo/.factory/STOP');
  });

  it('forwards queueFile, queueProposedFile, and costsFile through to the rendered App', async () => {
    const stdout = fakeStdout(true);
    const waitUntilExit = vi.fn().mockResolvedValue(undefined);
    const renderFn = vi.fn(() => ({
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
      render: renderFn as any,
      followPlainFn,
    });

    const [element] = renderFn.mock.calls[0] as unknown as [any, any];
    expect(element.props.queueFile).toBe('/repo/.factory/queue');
    expect(element.props.queueProposedFile).toBe('/repo/.factory/queue.proposed');
    expect(element.props.costsFile).toBe('/repo/.factory/costs.jsonl');
  });

  it('forwards approvalsDir through to the rendered App', async () => {
    const stdout = fakeStdout(true);
    const waitUntilExit = vi.fn().mockResolvedValue(undefined);
    const renderFn = vi.fn(() => ({
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
      render: renderFn as any,
      followPlainFn,
    });

    const [element] = renderFn.mock.calls[0] as unknown as [any, any];
    expect(element.props.approvalsDir).toBe('/repo/.factory/approvals');
  });
});
