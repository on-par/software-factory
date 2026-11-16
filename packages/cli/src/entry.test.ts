import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type EntryIo, readCliVersion, runEntry } from './entry.js';

function recordingEntry(fail = false) {
  const events: string[] = [];
  const io: EntryIo = {
    error: (m) => events.push(`error:${m}`),
    exit: (c) => events.push(`exit:${c}`),
  };
  const main = async () => {
    events.push('main');
    if (fail) throw new Error('boom');
  };
  return { io, events, main };
}

describe('runEntry', () => {
  it('runs main once and does not error or exit when main resolves', async () => {
    const { io, events, main } = recordingEntry();

    await runEntry(main, io);

    expect(events).toEqual(['main']);
  });

  it('prints the error message and exits 1 when main rejects', async () => {
    const { io, events, main } = recordingEntry(true);

    await runEntry(main, io);

    expect(events).toEqual(['main', 'error:boom', 'exit:1']);
  });

  it('uses the default io when none is given and main resolves', async () => {
    let runs = 0;

    await runEntry(async () => {
      runs += 1;
    });

    expect(runs).toBe(1);
  });

  it('refuses to start on a Node major below the minimum without calling main', async () => {
    const { io, events, main } = recordingEntry();

    await runEntry(main, io, 'v20.11.1', undefined, { NVM_DIR: '/x/.nvm' });

    expect(events).toHaveLength(2);
    expect(events[0]).toContain('needs Node.js 24 or newer (found v20.11.1)');
    expect(events[0]).toContain('nvm install 24');
    expect(events[1]).toBe('exit:1');
  });

  it('points at nodejs.org/download when nvm is absent without calling main', async () => {
    const { io, events, main } = recordingEntry();

    await runEntry(main, io, 'v20.11.1', '1.2.3', {});

    expect(events).toEqual([expect.any(String), 'exit:1']);
    expect(events).not.toContain('main');
    expect(events[0]).toContain('https://nodejs.org/download');
    expect(events[0]).not.toContain('nvm install');
  });

  it('pins the CLI version in the reinstall line without calling main', async () => {
    const { io, events, main } = recordingEntry();

    await runEntry(main, io, 'v20.11.1', '1.2.3');

    expect(events).not.toContain('main');
    expect(events[0]).toContain('@on-par/factory-cli@1.2.3');
    expect(events[1]).toBe('exit:1');
  });

  it('runs main at the minimum version', async () => {
    const { io, events, main } = recordingEntry();

    await runEntry(main, io, 'v24.0.0');

    expect(events).toEqual(['main']);
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
