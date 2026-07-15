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
});
