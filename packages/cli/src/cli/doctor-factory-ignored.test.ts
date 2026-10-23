import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { REPO_SECTION, runDoctorChecks } from './doctor.js';
import { factoryIgnoredChecks } from './doctor-factory-ignored.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** A git repo with `.factory/<file>` (when given) and the given ignore setup. */
function repo(opts: { file?: string; gitignore?: string; exclude?: string; track?: boolean }): string {
  const dir = tmp.makeSync('doctor-ignored-');
  git(dir, 'init', '-q');
  mkdirSync(join(dir, '.factory'));
  writeFileSync(join(dir, '.factory', opts.file ?? 'constitution.md'), 'version: 2\n');
  if (opts.gitignore !== undefined) writeFileSync(join(dir, '.gitignore'), opts.gitignore);
  if (opts.exclude !== undefined) writeFileSync(join(dir, '.git', 'info', 'exclude'), opts.exclude);
  if (opts.track) git(dir, 'add', '-f', '.factory');
  return dir;
}

describe('factoryIgnoredChecks (#3600)', () => {
  it('warns when .factory/ is excluded via .git/info/exclude, naming the file and the rule', () => {
    const dir = repo({ file: 'config.yaml', exclude: '.factory/\n' });

    const [check] = factoryIgnoredChecks(dir, tryExec, existsSync);

    expect(check).toMatchObject({ name: '.factory in git', ok: false, optional: true });
    expect(check!.detail).toBe(
      ".factory/config.yaml is git-ignored (.git/info/exclude:1:.factory/); the run snapshots config from the source checkout, but worktrees won't contain .factory/ files",
    );
    expect(check!.fix).toContain('commit .factory/config.yaml');
  });

  it('warns when the config file is git-ignored via .gitignore', () => {
    const dir = repo({ file: 'config.json', gitignore: '.factory/config.json\n' });

    const [check] = factoryIgnoredChecks(dir, tryExec, existsSync);

    expect(check!.detail).toContain('.factory/config.json is git-ignored (.gitignore:1:.factory/config.json)');
  });

  it('probes .factory/ itself when there is no config file', () => {
    const dir = repo({ gitignore: '.factory\n' });

    expect(factoryIgnoredChecks(dir, tryExec, existsSync)[0]!.detail).toContain('.factory/ is git-ignored');
  });

  it('does not warn when the config is tracked, even with a matching ignore rule', () => {
    const dir = repo({ file: 'config.yaml', exclude: '.factory/\n', track: true });

    expect(factoryIgnoredChecks(dir, tryExec, existsSync)).toEqual([]);
  });

  it('does not warn when nothing ignores .factory/', () => {
    expect(factoryIgnoredChecks(repo({ file: 'config.yaml' }), tryExec, existsSync)).toEqual([]);
  });

  it('does not warn when git is unavailable or prints nothing', () => {
    const exists = () => true;
    for (const output of [null, '']) expect(factoryIgnoredChecks('/repo', () => output, exists)).toEqual([]);
  });

  it('runDoctorChecks lists the warning in the Repo section after .factory initialized', () => {
    const dir = repo({ file: 'config.yaml', exclude: '.factory/\n' });
    const checks = runDoctorChecks({
      commandAvailable: () => true,
      envPresent: () => true,
      tryExec: (cmd) => (cmd.includes('git rev-parse') ? dir : tryExec(cmd)),
      pathExists: existsSync,
      platform: 'darwin',
    });

    const names = checks.map((c) => c.name);
    expect(names.indexOf('.factory in git')).toBe(names.indexOf('.factory initialized') + 1);
    expect(checks.find((c) => c.name === '.factory in git')).toMatchObject({ section: REPO_SECTION, ok: false });
  });
});
