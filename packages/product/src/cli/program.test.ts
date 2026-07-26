// packages/product/src/cli/program.test.ts (#469, #470).

import type * as NodeChildProcess from 'node:child_process';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProgram, defaultDeps, getProductVersion, main, type ProgramDeps } from './program.js';
import type { Prompter } from './prompter.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return { ...actual, execSync: vi.fn(actual.execSync) };
});

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(async () => 'answer'),
    close: vi.fn(),
  })),
}));

function stubPrompter(overrides: Partial<Prompter> = {}): Prompter {
  return {
    ask: vi.fn(async () => 'a substantive answer here'),
    close: vi.fn(),
    ...overrides,
  };
}

function stubDeps(overrides: Partial<ProgramDeps> = {}): ProgramDeps {
  return {
    repoRoot: '/repo',
    listAdrs: vi.fn(() => []),
    write: vi.fn(),
    readFile: vi.fn(async () => ''),
    createPrompter: vi.fn(() => stubPrompter()),
    ...overrides,
  };
}

describe('getProductVersion', () => {
  it('reads the version from package.json', () => {
    expect(getProductVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('buildProgram', () => {
  it('names the program product and lists the adr and interview commands in help', () => {
    const program = buildProgram(stubDeps());
    expect(program.name()).toBe('product');
    const help = program.helpInformation();
    expect(help).toContain('Usage: product');
    expect(help).toContain('adr');
    expect(help).toContain('interview');
  });
});

describe('main', () => {
  it('prints the ADR home for `adr home`', async () => {
    const deps = stubDeps();
    await main(['node', 'product', 'adr', 'home'], deps);
    expect(deps.write).toHaveBeenCalledWith(resolve('/repo/docs/adr'));
  });

  it('prints the next ADR filename for `adr next <title>`', async () => {
    const listAdrs = vi.fn(() => ['0001-a.md', '0002-b.md']);
    const deps = stubDeps({ listAdrs });
    await main(['node', 'product', 'adr', 'next', 'A Big Choice'], deps);
    expect(listAdrs).toHaveBeenCalledWith(resolve('/repo/docs/adr'));
    expect(deps.write).toHaveBeenCalledWith('0003-a-big-choice.md');
  });
});

describe('main: interview', () => {
  it('runs the loop from --text, asks via the prompter, and writes the summary lines', async () => {
    const prompter = stubPrompter();
    const createPrompter = vi.fn(() => prompter);
    const deps = stubDeps({ createPrompter });
    await main(['node', 'product', 'interview', '--text', 'Nothing notable to report right now.'], deps);

    expect(createPrompter).toHaveBeenCalled();
    expect(prompter.ask).toHaveBeenCalled();
    expect(deps.write).toHaveBeenCalledWith(expect.stringMatching(/^Asked \d+ of \d+ question\(s\); stopped: /));
    expect(deps.write).toHaveBeenCalledWith(expect.stringMatching(/^Pinned: /));
    expect(deps.write).toHaveBeenCalledWith(expect.stringMatching(/^Open gaps: /));
  });

  it('runs the loop from --file, reading its contents', async () => {
    const readFile = vi.fn(async () => 'Nothing notable to report right now.');
    const deps = stubDeps({ readFile });
    await main(['node', 'product', 'interview', '--file', 'notes.md'], deps);

    expect(readFile).toHaveBeenCalledWith('notes.md');
  });

  it('rejects with neither --text nor --file, without creating a prompter', async () => {
    const createPrompter = vi.fn(() => stubPrompter());
    const deps = stubDeps({ createPrompter });
    await expect(main(['node', 'product', 'interview'], deps)).rejects.toThrow(/pass --text/);
    expect(createPrompter).not.toHaveBeenCalled();
  });

  it('rejects when --file contents are whitespace only', async () => {
    const readFile = vi.fn(async () => '   \n  ');
    const deps = stubDeps({ readFile });
    await expect(main(['node', 'product', 'interview', '--file', 'blank.md'], deps)).rejects.toThrow(/pass --text/);
  });

  it('rejects a non-numeric --budget', async () => {
    const deps = stubDeps();
    await expect(main(['node', 'product', 'interview', '--text', 'x', '--budget', 'abc'], deps)).rejects.toThrow(
      /--budget must be a non-negative integer/,
    );
  });

  it('rejects a negative --budget', async () => {
    const deps = stubDeps();
    await expect(main(['node', 'product', 'interview', '--text', 'x', '--budget', '-1'], deps)).rejects.toThrow(
      /--budget must be a non-negative integer/,
    );
  });

  it('asks at most one question with --budget 1', async () => {
    const prompter = stubPrompter();
    const deps = stubDeps({ createPrompter: vi.fn(() => prompter) });
    await main(
      ['node', 'product', 'interview', '--text', 'Nothing notable to report right now.', '--budget', '1'],
      deps,
    );
    expect(vi.mocked(prompter.ask).mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('closes the prompter even when the run throws', async () => {
    const prompter = stubPrompter({
      ask: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const deps = stubDeps({ createPrompter: vi.fn(() => prompter) });
    await expect(
      main(['node', 'product', 'interview', '--text', 'Nothing notable to report right now.'], deps),
    ).rejects.toThrow('boom');
    expect(prompter.close).toHaveBeenCalled();
  });
});

describe('defaultDeps', () => {
  const gitRepoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the repo root from git, not process.cwd()', () => {
    expect(defaultDeps().repoRoot).toBe(gitRepoRoot);
  });

  it('writes via console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    defaultDeps().write('hello');
    expect(spy).toHaveBeenCalledWith('hello');
  });

  it('lists ADRs from the real docs/adr/ directory', () => {
    const result = defaultDeps().listAdrs(resolve(gitRepoRoot, 'docs/adr'));
    expect(Array.isArray(result)).toBe(true);
  });

  it('falls back to process.cwd() when git rev-parse fails', () => {
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw new Error('not a git repository');
    });
    expect(defaultDeps().repoRoot).toBe(process.cwd());
  });

  it('reads a real file via readFile', async () => {
    const contents = await defaultDeps().readFile(resolve(gitRepoRoot, 'package.json'));
    expect(contents).toContain('"name"');
  });

  it('creates a prompter without opening real stdin (readline/promises is mocked)', () => {
    const prompter = defaultDeps().createPrompter();
    expect(typeof prompter.ask).toBe('function');
    expect(typeof prompter.close).toBe('function');
  });
});
