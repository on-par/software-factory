import { describe, expect, it, type Mock, vi } from 'vitest';
import { type EntryIo, runEntry } from './entry.js';

function recordingIo(): EntryIo & { error: Mock<(msg: string) => void>; exit: Mock<(code: number) => void> } {
  return { error: vi.fn(), exit: vi.fn() };
}

describe('runEntry', () => {
  it('runs main once and does not error or exit when main resolves', async () => {
    const io = recordingIo();
    const main = vi.fn(async () => {});

    await runEntry(main, io);

    expect(main).toHaveBeenCalledTimes(1);
    expect(io.error).not.toHaveBeenCalled();
    expect(io.exit).not.toHaveBeenCalled();
  });

  it('prints the error message and exits 1 when main rejects', async () => {
    const io = recordingIo();
    const main = vi.fn(async () => {
      throw new Error('boom');
    });

    await runEntry(main, io);

    expect(io.error).toHaveBeenCalledWith('boom');
    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.error.mock.invocationCallOrder[0]).toBeLessThan(io.exit.mock.invocationCallOrder[0]);
  });

  it('uses the default io when none is given and main resolves', async () => {
    const main = vi.fn(async () => {});

    await runEntry(main);

    expect(main).toHaveBeenCalledTimes(1);
  });

  it('refuses to start on a Node major below the minimum without calling main', async () => {
    const io = recordingIo();
    const main = vi.fn(async () => {});

    await runEntry(main, io, 'v20.11.1');

    expect(main).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledTimes(1);
    expect(io.error.mock.calls[0][0]).toContain('needs Node.js 24 or newer (found v20.11.1)');
    expect(io.error.mock.calls[0][0]).toContain('nvm install 24');
    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.error.mock.invocationCallOrder[0]).toBeLessThan(io.exit.mock.invocationCallOrder[0]);
  });

  it('runs main at the minimum version', async () => {
    const io = recordingIo();
    const main = vi.fn(async () => {});

    await runEntry(main, io, 'v24.0.0');

    expect(main).toHaveBeenCalledTimes(1);
    expect(io.error).not.toHaveBeenCalled();
    expect(io.exit).not.toHaveBeenCalled();
  });
});
