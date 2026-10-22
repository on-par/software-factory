import { readFileSync } from 'node:fs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { type EntryIo, isVersionRequest, readCliVersion, runEntry } from './entry.js';

function recordingIo(): EntryIo & {
  log: Mock<(msg: string) => void>;
  error: Mock<(msg: string) => void>;
  exit: Mock<(code: number) => void>;
} {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

describe('runEntry --version fast path (#3251)', () => {
  const run = (args: string[], cliVersion = '1.2.3', nodeVersion = 'v24.0.0') => {
    const io = recordingIo();
    const main = vi.fn(async () => {});
    return runEntry(main, io, nodeVersion, cliVersion, {}, args).then(() => ({ io, main }));
  };

  it.each([['--version'], ['-V']])('%s logs the version and never calls main', async (flag) => {
    const { io, main } = await run([flag]);
    expect(io.log).toHaveBeenCalledWith('1.2.3');
    expect(main).not.toHaveBeenCalled();
    expect(io.exit).not.toHaveBeenCalled();
  });

  it.each([[['--version', 'x']], [['tui', '--version']], [[]], [['-v']], [['--VERSION']]])(
    '%j falls through to main',
    async (args) => {
      const { io, main } = await run(args);
      expect(main).toHaveBeenCalledTimes(1);
      expect(io.log).not.toHaveBeenCalled();
    },
  );

  it('falls through to main when the version is unreadable', async () => {
    const { io, main } = await run(['--version'], '');
    expect(main).toHaveBeenCalledTimes(1);
    expect(io.log).not.toHaveBeenCalled();
  });

  it('lets the Node gate win over --version', async () => {
    const { io, main } = await run(['--version'], '1.2.3', 'v20.11.1');
    expect(main).not.toHaveBeenCalled();
    expect(io.log).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledTimes(1);
    expect(io.exit).toHaveBeenCalledWith(1);
  });
});

describe('isVersionRequest', () => {
  it.each([
    [['--version'], true],
    [['-V'], true],
    [[], false],
    [['--version', 'extra'], false],
    [['--state-root', '/x', '--version'], false],
    [['-v'], false],
    [['--VERSION'], false],
  ])('%j -> %s', (args, expected) => {
    expect(isVersionRequest(args)).toBe(expected);
  });
});

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

    await runEntry(main, io, 'v20.11.1', undefined, { NVM_DIR: '/x/.nvm' });

    expect(main).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledTimes(1);
    expect(io.error.mock.calls[0][0]).toContain('needs Node.js 24 or newer (found v20.11.1)');
    expect(io.error.mock.calls[0][0]).toContain('nvm install 24');
    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.error.mock.invocationCallOrder[0]).toBeLessThan(io.exit.mock.invocationCallOrder[0]);
  });

  it('points at nodejs.org/download when nvm is absent without calling main', async () => {
    const io = recordingIo();
    const main = vi.fn(async () => {});

    await runEntry(main, io, 'v20.11.1', '1.2.3', {});

    expect(main).not.toHaveBeenCalled();
    expect(io.error.mock.calls[0][0]).toContain('https://nodejs.org/download');
    expect(io.error.mock.calls[0][0]).not.toContain('nvm install');
    expect(io.exit).toHaveBeenCalledWith(1);
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
