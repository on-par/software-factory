import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { healFactoryExclude, SAMPLE_QUEUE, writeSampleQueue } from './init-files.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'init-files-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('healFactoryExclude', () => {
  it('does not create the exclude file when it does not exist', () => {
    const file = join(dir, 'exclude');
    expect(healFactoryExclude(file)).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('does nothing when the exclude path is under a file (.git is a worktree pointer)', () => {
    writeFileSync(join(dir, 'git'), 'gitdir: elsewhere\n');
    expect(healFactoryExclude(join(dir, 'git', 'info', 'exclude'))).toBe(false);
  });

  it('removes bare .factory/ and .factory lines and keeps everything else', () => {
    const file = join(dir, 'exclude');
    writeFileSync(
      file,
      '# git ls-files --others --exclude-from=.git/info/exclude\n*.swp\n.factory/\n  .factory  \n/.factory/worktrees/\nfoo.factory/bar\n# .factory/\n',
    );
    expect(healFactoryExclude(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe(
      '# git ls-files --others --exclude-from=.git/info/exclude\n*.swp\n/.factory/worktrees/\nfoo.factory/bar\n# .factory/\n',
    );
  });

  it('leaves the file untouched when there is no bare .factory line', () => {
    const file = join(dir, 'exclude');
    writeFileSync(file, '*.swp\n/.factory/worktrees/');
    expect(healFactoryExclude(file)).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe('*.swp\n/.factory/worktrees/');
  });

  it('rethrows other read errors', () => {
    const file = join(dir, 'exclude');
    mkdirSync(file);
    expect(() => healFactoryExclude(file)).toThrow(/EISDIR/);
  });
});

describe('writeSampleQueue', () => {
  it('writes the sample queue when none exists', () => {
    const file = join(dir, 'queue');
    expect(writeSampleQueue(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe(SAMPLE_QUEUE);
  });

  it('never overwrites an existing queue', () => {
    const file = join(dir, 'queue');
    writeFileSync(file, 'app 61\n');
    expect(writeSampleQueue(file)).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe('app 61\n');
  });

  it('rethrows write errors other than EEXIST', () => {
    expect(() => writeSampleQueue(join(dir, 'missing-dir', 'queue'))).toThrow(/ENOENT/);
  });
});
