// packages/product/src/cli/program.test.ts (#469, #470, #471).

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

const SPARSE_DUMP = 'The manual export process breaks every week and wastes an afternoon.';
const FULL_DUMP =
  'The manual export process breaks every week and wastes an afternoon, as a user on the ops team ' +
  'we need this so that we reduce the manual toil; build the smallest slice, but out of scope for now is ' +
  'automated retries, and this must ship before the deadline given the legacy platform constraint.';

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
    expect(help).toContain('intent');
    expect(help).toContain('decompose');
    expect(help).toContain('personas');
    expect(help).toContain('judge');
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

describe('main: intent', () => {
  it('builds the intent doc from --text and writes it, closing the prompter', async () => {
    const prompter = stubPrompter();
    const createPrompter = vi.fn(() => prompter);
    const deps = stubDeps({ createPrompter });
    await main(['node', 'product', 'intent', '--text', SPARSE_DUMP, '--budget', '0'], deps);

    expect(deps.write).toHaveBeenCalledWith('# Intent Doc');
    expect(deps.write).toHaveBeenCalledWith(expect.stringMatching(/^Status: draft$/));
    expect(prompter.close).toHaveBeenCalled();
  });

  it('reads the brain-dump from --file', async () => {
    const readFile = vi.fn(async () => SPARSE_DUMP);
    const deps = stubDeps({ readFile });
    await main(['node', 'product', 'intent', '--file', 'notes.md', '--budget', '0'], deps);

    expect(readFile).toHaveBeenCalledWith('notes.md');
  });

  it('asks via the prompter when the budget allows a clarifying question', async () => {
    const prompter = stubPrompter();
    const deps = stubDeps({ createPrompter: vi.fn(() => prompter) });
    await main(['node', 'product', 'intent', '--text', SPARSE_DUMP, '--budget', '1'], deps);

    expect(prompter.ask).toHaveBeenCalled();
  });

  it('rejects with neither --text nor --file, without creating a prompter', async () => {
    const createPrompter = vi.fn(() => stubPrompter());
    const deps = stubDeps({ createPrompter });
    await expect(main(['node', 'product', 'intent'], deps)).rejects.toThrow(/pass --text/);
    expect(createPrompter).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric --budget', async () => {
    const deps = stubDeps();
    await expect(main(['node', 'product', 'intent', '--text', SPARSE_DUMP, '--budget', 'abc'], deps)).rejects.toThrow(
      /--budget must be a non-negative integer/,
    );
  });

  it('approves and writes Status: approved plus Approved by when the interview pins everything', async () => {
    const deps = stubDeps();
    await main(['node', 'product', 'intent', '--text', FULL_DUMP, '--budget', '0', '--approve', 'Pat'], deps);

    expect(deps.write).toHaveBeenCalledWith('Status: approved');
    expect(deps.write).toHaveBeenCalledWith('Approved by: Pat');
  });

  it('rejects with cannot approve and still writes the draft lines when gaps remain', async () => {
    const deps = stubDeps();
    await expect(
      main(['node', 'product', 'intent', '--text', SPARSE_DUMP, '--budget', '0', '--approve', 'Pat'], deps),
    ).rejects.toThrow(/cannot approve/);

    expect(deps.write).toHaveBeenCalledWith('# Intent Doc');
    expect(deps.write).toHaveBeenCalledWith(expect.stringMatching(/^Status: draft$/));
  });
});

const BLOCKED_DUMP =
  'The manual export process breaks every week and wastes an afternoon, as a user on the ops team ' +
  'we need this so that we reduce the manual toil; refactor and build the smallest slice, but out of scope for ' +
  'now is automated retries, and this must ship before the deadline given the legacy platform constraint.';

describe('main: decompose', () => {
  it('approves the intent doc and writes the rendered decomposition', async () => {
    const deps = stubDeps();
    await main(['node', 'product', 'decompose', '--text', FULL_DUMP, '--budget', '0', '--approve', 'Pat'], deps);

    expect(deps.write).toHaveBeenCalledWith('# Decomposition');
    expect(deps.write).toHaveBeenCalledWith(expect.stringMatching(/^## Epic: /));
  });

  it('reads the brain-dump from --file', async () => {
    const readFile = vi.fn(async () => FULL_DUMP);
    const deps = stubDeps({ readFile });
    await main(['node', 'product', 'decompose', '--file', 'notes.md', '--budget', '0', '--approve', 'Pat'], deps);

    expect(readFile).toHaveBeenCalledWith('notes.md');
  });

  it('asks via the prompter when the budget allows a clarifying question', async () => {
    const prompter = stubPrompter();
    const deps = stubDeps({ createPrompter: vi.fn(() => prompter) });
    await expect(
      main(['node', 'product', 'decompose', '--text', SPARSE_DUMP, '--budget', '1', '--approve', 'Pat'], deps),
    ).rejects.toThrow();

    expect(prompter.ask).toHaveBeenCalled();
  });

  it('rejects without --approve, without creating a prompter', async () => {
    const createPrompter = vi.fn(() => stubPrompter());
    const deps = stubDeps({ createPrompter });
    await expect(main(['node', 'product', 'decompose', '--text', FULL_DUMP, '--budget', '0'], deps)).rejects.toThrow(
      /required option/,
    );
    expect(createPrompter).not.toHaveBeenCalled();
  });

  it('rejects with cannot approve and still writes the draft lines when gaps remain', async () => {
    const deps = stubDeps();
    await expect(
      main(['node', 'product', 'decompose', '--text', SPARSE_DUMP, '--budget', '0', '--approve', 'Pat'], deps),
    ).rejects.toThrow(/cannot approve/);

    expect(deps.write).toHaveBeenCalledWith('# Intent Doc');
    expect(deps.write).toHaveBeenCalledWith(expect.stringMatching(/^Status: draft$/));
  });

  it('rejects with the decomposition blockers when a scope statement is horizontal', async () => {
    const deps = stubDeps();
    await expect(
      main(['node', 'product', 'decompose', '--text', BLOCKED_DUMP, '--budget', '0', '--approve', 'Pat'], deps),
    ).rejects.toThrow(/^product decompose: /);
  });
});

describe('main: personas', () => {
  it('approves the intent doc, decomposes it, and writes the rendered persona panel', async () => {
    const deps = stubDeps();
    await main(['node', 'product', 'personas', '--text', FULL_DUMP, '--budget', '0', '--approve', 'Pat'], deps);

    expect(deps.write).toHaveBeenCalledWith('# Persona Panel');
    expect(deps.write).toHaveBeenCalledWith(expect.stringMatching(/^Findings: \d+ from /));
  });

  it('reads the brain-dump from --file', async () => {
    const readFile = vi.fn(async () => FULL_DUMP);
    const deps = stubDeps({ readFile });
    await main(['node', 'product', 'personas', '--file', 'notes.md', '--budget', '0', '--approve', 'Pat'], deps);

    expect(readFile).toHaveBeenCalledWith('notes.md');
  });

  it('rejects without --approve, without creating a prompter', async () => {
    const createPrompter = vi.fn(() => stubPrompter());
    const deps = stubDeps({ createPrompter });
    await expect(main(['node', 'product', 'personas', '--text', FULL_DUMP, '--budget', '0'], deps)).rejects.toThrow(
      /required option/,
    );
    expect(createPrompter).not.toHaveBeenCalled();
  });

  it('rejects with cannot approve and still writes the draft lines when gaps remain', async () => {
    const deps = stubDeps();
    await expect(
      main(['node', 'product', 'personas', '--text', SPARSE_DUMP, '--budget', '0', '--approve', 'Pat'], deps),
    ).rejects.toThrow(/^product personas: cannot approve — /);

    expect(deps.write).toHaveBeenCalledWith('# Intent Doc');
    expect(deps.write).toHaveBeenCalledWith(expect.stringMatching(/^Status: draft$/));
  });

  it('rejects with the decomposition blockers when a scope statement is horizontal', async () => {
    const deps = stubDeps();
    await expect(
      main(['node', 'product', 'personas', '--text', BLOCKED_DUMP, '--budget', '0', '--approve', 'Pat'], deps),
    ).rejects.toThrow(/^product personas: /);
  });
});

describe('main: judge', () => {
  it('approves the intent doc, decomposes it, judges each story, and writes the rendered report', async () => {
    const deps = stubDeps();
    await main(['node', 'product', 'judge', '--text', FULL_DUMP, '--budget', '0', '--approve', 'Pat'], deps);

    expect(deps.write).toHaveBeenCalledWith('# Judge Report');
    expect(deps.write).toHaveBeenCalledWith(expect.stringMatching(/^Threshold: \d+ · Max rework iterations: \d+$/));
  });

  it('reads the brain-dump from --file', async () => {
    const readFile = vi.fn(async () => FULL_DUMP);
    const deps = stubDeps({ readFile });
    await main(['node', 'product', 'judge', '--file', 'notes.md', '--budget', '0', '--approve', 'Pat'], deps);

    expect(readFile).toHaveBeenCalledWith('notes.md');
  });

  it('rejects without --approve, without creating a prompter', async () => {
    const createPrompter = vi.fn(() => stubPrompter());
    const deps = stubDeps({ createPrompter });
    await expect(main(['node', 'product', 'judge', '--text', FULL_DUMP, '--budget', '0'], deps)).rejects.toThrow(
      /required option/,
    );
    expect(createPrompter).not.toHaveBeenCalled();
  });

  it('rejects with cannot approve and still writes the draft lines when gaps remain', async () => {
    const deps = stubDeps();
    await expect(
      main(['node', 'product', 'judge', '--text', SPARSE_DUMP, '--budget', '0', '--approve', 'Pat'], deps),
    ).rejects.toThrow(/^product judge: cannot approve — /);

    expect(deps.write).toHaveBeenCalledWith('# Intent Doc');
    expect(deps.write).toHaveBeenCalledWith(expect.stringMatching(/^Status: draft$/));
  });

  it('rejects with the decomposition blockers when a scope statement is horizontal', async () => {
    const deps = stubDeps();
    await expect(
      main(['node', 'product', 'judge', '--text', BLOCKED_DUMP, '--budget', '0', '--approve', 'Pat'], deps),
    ).rejects.toThrow(/^product judge: /);
  });

  it('rejects an out-of-range --threshold', async () => {
    const deps = stubDeps();
    await expect(
      main(
        ['node', 'product', 'judge', '--text', FULL_DUMP, '--budget', '0', '--approve', 'Pat', '--threshold', '150'],
        deps,
      ),
    ).rejects.toThrow(/^product judge: --threshold must be a number between 0 and 100/);
  });

  it('rejects a non-numeric --threshold', async () => {
    const deps = stubDeps();
    await expect(
      main(
        ['node', 'product', 'judge', '--text', FULL_DUMP, '--budget', '0', '--approve', 'Pat', '--threshold', 'abc'],
        deps,
      ),
    ).rejects.toThrow(/^product judge: --threshold must be a number between 0 and 100/);
  });

  it('rejects a negative --max-iterations', async () => {
    const deps = stubDeps();
    await expect(
      main(
        [
          'node',
          'product',
          'judge',
          '--text',
          FULL_DUMP,
          '--budget',
          '0',
          '--approve',
          'Pat',
          '--max-iterations',
          '-1',
        ],
        deps,
      ),
    ).rejects.toThrow(/^product judge: --max-iterations must be a non-negative integer/);
  });

  it('rejects a non-numeric --max-iterations', async () => {
    const deps = stubDeps();
    await expect(
      main(
        ['node', 'product', 'judge', '--text', FULL_DUMP, '--budget', '0', '--approve', 'Pat', '--max-iterations', 'x'],
        deps,
      ),
    ).rejects.toThrow(/^product judge: --max-iterations must be a non-negative integer/);
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
