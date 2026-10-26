import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from './cli/program.js';
import { main, PROGRAM_HANDLERS } from './cli/index.js';

// init has no prompts, so --yes / -y is an accepted no-op (#2546).
describe('init --yes', () => {
  const originalCwd = process.cwd();
  const tempDirs: string[] = [];
  let errors: string[];

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function snapshot(root: string): [string, string | null][] {
    const out: [string, string | null][] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const abs = join(dir, name);
        const rel = relative(root, abs);
        if (statSync(abs).isDirectory()) {
          out.push([rel, null]);
          walk(abs);
        } else out.push([rel, readFileSync(abs, 'utf-8')]);
      }
    };
    walk(join(root, '.factory'));
    out.push(['.git/info/exclude', readFileSync(join(root, '.git', 'info', 'exclude'), 'utf-8')]);
    return out;
  }

  /** `git check-ignore` exit status: 0 ignored, 1 not ignored. */
  function checkIgnore(root: string, path: string): number {
    return spawnSync('git', ['check-ignore', '-q', path], { cwd: root }).status ?? -1;
  }

  async function initInFreshRepo(...args: string[]) {
    const root = mkdtempSync(join(tmpdir(), 'factory-init-yes-'));
    tempDirs.push(root);
    execFileSync('git', ['init', '-q', root]);
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    process.chdir(root);
    await main(['node', 'factory', 'init', ...args]);
    expect(process.exitCode).toBeUndefined();
    expect(errors.join('\n')).not.toContain('unknown option');
    return snapshot(root);
  }

  it('--yes exits 0 and writes the same files as plain init', async () => {
    const yesSnapshot = await initInFreshRepo('--yes');
    const plainSnapshot = await initInFreshRepo();
    expect(yesSnapshot).toEqual(plainSnapshot);
  });

  it('-y is accepted and writes the same files as --yes', async () => {
    const shortSnapshot = await initInFreshRepo('-y');
    const longSnapshot = await initInFreshRepo('--yes');
    expect(shortSnapshot).toEqual(longSnapshot);
  });

  // init must not git-ignore .factory/config.yaml (#3689).
  it('leaves .factory/config.yaml committable in a fresh repo', async () => {
    await initInFreshRepo();
    expect(checkIgnore(tempDirs.at(-1)!, '.factory/config.yaml')).toBe(1);
  });

  it('re-init drops a legacy .factory/ exclude line and keeps the rest', async () => {
    await initInFreshRepo();
    const root = tempDirs.at(-1)!;
    const exclude = join(root, '.git', 'info', 'exclude');
    writeFileSync(exclude, '*.swp\n.factory/\n');
    expect(checkIgnore(root, '.factory/config.yaml')).toBe(0);
    await main(['node', 'factory', 'init']);
    expect(readFileSync(exclude, 'utf-8')).toBe('*.swp\n');
    expect(checkIgnore(root, '.factory/config.yaml')).toBe(1);
  });

  it('--help lists -y, --yes', () => {
    const init = buildProgram(PROGRAM_HANDLERS, {}).commands.find((c) => c.name() === 'init');
    expect(init?.helpInformation()).toContain('-y, --yes');
  });
});
