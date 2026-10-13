import { readFileSync } from 'node:fs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { type EntryIo, readCliVersion, runEntry } from './entry.js';

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

  it('pins the CLI version in the reinstall line without calling main', async () => {
    const io = recordingIo();
    const main = vi.fn(async () => {});

    await runEntry(main, io, 'v20.11.1', '1.2.3');

    expect(main).not.toHaveBeenCalled();
    expect(io.error.mock.calls[0][0]).toContain('@on-par/factory-cli@1.2.3');
    expect(io.exit).toHaveBeenCalledWith(1);
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

describe('readCliVersion', () => {
  it('returns the version in packages/cli/package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(readCliVersion()).toBe(pkg.version);
  });

  it("falls back to '' when the loader throws or has no string version", () => {
    expect(
      readCliVersion(() => {
        throw new Error('x');
      }),
    ).toBe('');
    expect(readCliVersion(() => ({}))).toBe('');
    expect(readCliVersion(() => null)).toBe('');
  });
});
