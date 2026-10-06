import { describe, expect, it, type Mock, vi } from 'vitest';
import { type EntryIo, runEntry } from './entry.js';

function recordingIo(): EntryIo & { error: Mock<(msg: string) => void>; exit: Mock<(code: number) => void> } {
  return { error: vi.fn(), exit: vi.fn() };
}

describe('runEntry', () => {
  it('exits with the code main resolves with', async () => {
    const io = recordingIo();
    const main = vi.fn(async () => 3);

    await runEntry(main, io);

    expect(main).toHaveBeenCalledTimes(1);
    expect(io.exit).toHaveBeenCalledWith(3);
    expect(io.exit).toHaveBeenCalledTimes(1);
    expect(io.error).not.toHaveBeenCalled();
  });

  it('exits 0 when main resolves with 0', async () => {
    const io = recordingIo();

    await runEntry(async () => 0, io);

    expect(io.exit).toHaveBeenCalledWith(0);
    expect(io.error).not.toHaveBeenCalled();
  });

  it('prints the error message and exits 2 when main rejects with an Error', async () => {
    const io = recordingIo();
    const main = vi.fn(async () => {
      throw new Error('boom');
    });

    await runEntry(main, io);

    expect(io.error).toHaveBeenCalledWith('boom');
    expect(io.exit).toHaveBeenCalledWith(2);
    expect(io.error.mock.invocationCallOrder[0]).toBeLessThan(io.exit.mock.invocationCallOrder[0]);
  });

  it('prints String(err) and exits 2 when main rejects with a non-Error', async () => {
    const io = recordingIo();
    const main = vi.fn(async () => {
      throw 'oops';
    });

    await runEntry(main, io);

    expect(io.error).toHaveBeenCalledWith('oops');
    expect(io.exit).toHaveBeenCalledWith(2);
  });
});
