import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { TempDirs } from '../harness/temp-dir.js';

export function makeRepo(
  dirs: TempDirs,
  prefix: string,
  files: Readonly<Record<string, string>>,
  message = 'start',
): string {
  const repo = dirs.makeSync(prefix);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(repo, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents);
  }
  git(['add', '.']);
  git(['commit', '-q', '-m', message]);
  return repo;
}
