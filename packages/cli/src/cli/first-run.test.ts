import { exec, execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ConstitutionLoader, getConstitutionsDir } from '@on-par/factory-core';
import { describeConstitutionSource, laneWorktreePath, setupWorktree } from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOCS_URL,
  formatOverview,
  missingClaudeCliMessage,
  missingTokenMessage,
  notInitializedMessage,
} from './first-run.js';
import { main } from './index.js';

const execAsync = promisify(exec);

describe('formatOverview', () => {
  it('matches the frozen copy', () => {
    expect(formatOverview()).toMatchInlineSnapshot(`
      "factory — ship verified GitHub issues autonomously

      The software factory takes issues from your backlog through a
      plan → build → check → ship pipeline using a boss-worker-checker
      pattern, and opens a pull request for each one.

      Common commands:
        factory init                     Initialize .factory/ in this repo
        factory ship <issue>             Plan → build → check one issue and open a PR
        factory queue add <lane> <N...>  Queue issues into a lane (GitHub labels)
        factory run                      Ship queued issues, lanes in parallel
        factory status                   Show active runs and the queue

      Check your setup:       factory doctor
      All commands:           factory --help
      Docs:                   https://github.com/on-par/software-factory#readme
      "
    `);
  });

  it('contains the common-command hints and docs URL', () => {
    const overview = formatOverview();
    expect(overview).toContain('factory init');
    expect(overview).toContain('factory ship <issue>');
    expect(overview).toContain('factory queue add');
    expect(overview).toContain('factory run');
    expect(overview).toContain('factory doctor');
    expect(overview).toContain(DOCS_URL);
  });

  it('never leaks a stack trace or internal paths', () => {
    const overview = formatOverview();
    expect(overview).not.toContain('Error');
    expect(overview).not.toContain('at ');
    expect(overview).not.toContain('node_modules');
  });
});

describe('missingClaudeCliMessage', () => {
  it('matches the frozen copy', () => {
    expect(missingClaudeCliMessage()).toMatchInlineSnapshot(
      `"claude CLI not found — install Claude Code first: https://docs.anthropic.com/en/docs/claude-code"`,
    );
  });

  it('contains the acceptance-criteria substring verbatim', () => {
    expect(missingClaudeCliMessage()).toContain('claude CLI not found — install Claude Code first:');
  });
});

describe('missingTokenMessage', () => {
  it('matches the frozen copy', () => {
    expect(missingTokenMessage()).toMatchInlineSnapshot(
      `"GITHUB_TOKEN not set — create a token at https://github.com/settings/tokens and export it (or run \`gh auth login\`)"`,
    );
  });

  it('contains the acceptance-criteria substring verbatim', () => {
    expect(missingTokenMessage()).toContain(
      'GITHUB_TOKEN not set — create a token at https://github.com/settings/tokens and export it',
    );
  });
});

describe('notInitializedMessage', () => {
  it('matches the frozen copy', () => {
    expect(notInitializedMessage()).toMatchInlineSnapshot(`"factory not initialized — run \`factory init\` first"`);
  });

  it('contains the acceptance-criteria substring verbatim', () => {
    expect(notInitializedMessage()).toContain('factory not initialized — run `factory init` first');
  });
});

describe('factory init → lane worktree constitution (integration)', () => {
  let root: string;
  let repo: string;
  let savedStateRoot: string | undefined;

  const sh = (cmd: string, cwd: string = repo): string => execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'first-run-constitution-')));
    repo = join(root, 'widget');
    mkdirSync(repo);
    sh(
      'git init -q -b main && git config user.email t@t && git config user.name t && echo x > a.txt && git add a.txt && git commit -q -m init',
    );
    sh(`git init -q --bare '${join(root, 'origin.git')}'`);
    sh(`git remote add origin '${join(root, 'origin.git')}' && git push -q origin main`);
    savedStateRoot = process.env.FACTORY_STATE_ROOT;
    delete process.env.FACTORY_STATE_ROOT;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedStateRoot === undefined) delete process.env.FACTORY_STATE_ROOT;
    else process.env.FACTORY_STATE_ROOT = savedStateRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves the edited .factory/constitution.md from the main checkout for a ship-style lane worktree', async () => {
    await main(['node', 'factory', 'init'], {
      exec: async (cmd, opts) => {
        const { stdout, stderr } = await execAsync(cmd, {
          cwd: opts?.cwd ?? repo,
          timeout: opts?.timeout,
          encoding: 'utf-8',
        });
        return { stdout: String(stdout), stderr: String(stderr) };
      },
    });
    expect(existsSync(join(repo, '.factory/constitution.md'))).toBe(true);
    expect(readFileSync(join(repo, '.git/info/exclude'), 'utf-8')).toContain('.factory/');

    const marker = 'FACTORY-2413-MARKER-' + Date.now();
    appendFileSync(join(repo, '.factory/constitution.md'), '\n\n' + marker + '\n');

    const worktree = laneWorktreePath({
      repoRoot: repo,
      parent: join(root, 'worktrees'),
      repo: 'acme/widget',
      issue: 2413,
      prefix: 'factory',
    });
    await setupWorktree(repo, 'factory/2413-marker', worktree, 'origin/main');
    // .factory/ is git-excluded, so the lane worktree never contains the file.
    expect(existsSync(join(worktree, '.factory/constitution.md'))).toBe(false);

    const resolved = new ConstitutionLoader().resolve(worktree, 'example-data-app', undefined, repo);
    expect(resolved).not.toBeNull();
    expect(resolved!.body).toContain(marker);
    expect(resolved!.path).toBe(join(repo, '.factory', 'constitution.md'));
    expect(resolved!.path.startsWith(getConstitutionsDir())).toBe(false);
  }, 30_000);

  it('factory init with no product scaffolds default-code and the lane resolves no custom_* checkers', async () => {
    await main(['node', 'factory', 'init'], {
      exec: async (cmd, opts) => {
        const { stdout, stderr } = await execAsync(cmd, {
          cwd: opts?.cwd ?? repo,
          timeout: opts?.timeout,
          encoding: 'utf-8',
        });
        return { stdout: String(stdout), stderr: String(stderr) };
      },
    });
    expect(readFileSync(join(repo, '.factory/constitution.md'), 'utf-8')).toBe(
      readFileSync(join(getConstitutionsDir(), 'default-code.md'), 'utf-8'),
    );

    const worktree = laneWorktreePath({
      repoRoot: repo,
      parent: join(root, 'worktrees'),
      repo: 'acme/widget',
      issue: 2387,
      prefix: 'factory',
    });
    await setupWorktree(repo, 'factory/2387-default-code', worktree, 'origin/main');

    const resolved = new ConstitutionLoader().resolve(worktree, undefined, undefined, repo);
    expect(resolved).not.toBeNull();
    expect(resolved!.product).toBe('default-code');
    expect(resolved!.checkers.some((c) => c.startsWith('custom_'))).toBe(false);
    expect(describeConstitutionSource(resolved)).toMatch(/^Standards from \.factory\/constitution\.md \(/);
  }, 30_000);
});
