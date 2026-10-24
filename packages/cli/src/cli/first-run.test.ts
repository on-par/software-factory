import { exec, execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ConstitutionLoader, getConstitutionsDir, workKeyFromIssue } from '@on-par/factory-core';
import {
  describeConstitutionSource,
  laneWorktreePath,
  lintFactoryConfig,
  openCodeVersion,
  setupWorktree,
} from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOCS_URL,
  formatOverview,
  availableAgentClis,
  missingAgentCliMessage,
  missingTokenMessage,
  notInitializedMessage,
  OPENCODE_URL,
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

describe('missingAgentCliMessage', () => {
  it('names Pi install and sign-in (#2903)', () => {
    const msg = missingAgentCliMessage();
    expect(msg).toContain('@earendil-works/pi-coding-agent');
    expect(msg).toContain('/login');
  });

  it('names both supported agent CLIs and their sign-in commands', () => {
    const msg = missingAgentCliMessage();
    expect(msg).toContain('no coding agent CLI found on PATH');
    expect(msg).toContain('Claude Code');
    expect(msg).toContain('Codex CLI');
    expect(msg).toContain('claude /login');
    expect(msg).toContain('codex login');
  });

  it('gives OpenCode install and sign-in steps', () => {
    const msg = missingAgentCliMessage();
    expect(msg).toContain('https://opencode.ai');
    expect(msg).toContain(OPENCODE_URL);
    expect(msg).toContain('opencode auth login');
    expect(msg).toContain(openCodeVersion.OPENCODE_PINNED_INSTALL);
  });

  it('says OpenCode models need FACTORY_EXPERIMENTAL=1', () => {
    expect(missingAgentCliMessage()).toContain('FACTORY_EXPERIMENTAL=1');
  });
});

describe('availableAgentClis', () => {
  it('lists only the agent CLIs found on PATH', () => {
    expect(availableAgentClis((c) => c === 'codex')).toEqual(['codex']);
    expect(availableAgentClis(() => false)).toEqual([]);
  });

  it('pi alone is enough (#2903)', () => {
    expect(availableAgentClis((c) => c === 'pi')).toEqual(['pi']);
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
      key: workKeyFromIssue(2413),
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
      key: workKeyFromIssue(2387),
      prefix: 'factory',
    });
    await setupWorktree(repo, 'factory/2387-default-code', worktree, 'origin/main');

    const resolved = new ConstitutionLoader().resolve(worktree, undefined, undefined, repo);
    expect(resolved).not.toBeNull();
    expect(resolved!.product).toBe('default-code');
    expect(resolved!.checkers.some((c) => c.startsWith('custom_'))).toBe(false);
    expect(describeConstitutionSource(resolved)).toMatch(/^Standards from \.factory\/constitution\.md \(/);
  }, 30_000);

  const scaffoldExec = async (
    cmd: string,
    opts?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string }> => {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: opts?.cwd ?? repo,
      timeout: opts?.timeout,
      encoding: 'utf-8',
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  };

  it('an unedited factory init scaffold passes the config preflight', async () => {
    await main(['node', 'factory', 'init'], { exec: scaffoldExec });
    expect(existsSync(join(repo, '.factory/config.yaml'))).toBe(true);

    const constitution = new ConstitutionLoader().loadRepoConstitution(repo);
    expect(constitution).not.toBeNull();
    const result = lintFactoryConfig({
      constitution,
      configFile: { absPath: join(repo, '.factory/config.yaml'), relPath: '.factory/config.yaml' },
    });
    expect(result.findings).toEqual([]);
    expect(result.verdict).toBe('ok');
  }, 30_000);

  it('an unedited factory constitution --init scaffold passes the config preflight', async () => {
    await main(['node', 'factory', 'constitution', '--init'], { exec: scaffoldExec });

    const constitution = new ConstitutionLoader().loadRepoConstitution(repo);
    expect(constitution).not.toBeNull();
    expect(constitution!.checkers.length).toBeGreaterThan(0);
    const result = lintFactoryConfig({ constitution });
    expect(result.findings).toEqual([]);
    expect(result.verdict).toBe('ok');
  }, 30_000);
});
