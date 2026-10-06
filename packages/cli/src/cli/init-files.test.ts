import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureFactoryExcluded, SAMPLE_QUEUE, writeSampleQueue } from './init-files.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'init-files-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureFactoryExcluded', () => {
  it('creates the exclude file when it does not exist', () => {
    const file = join(dir, 'exclude');
    expect(ensureFactoryExcluded(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe('\n.factory/\n');
  });

  it('appends the entry on a new line after existing content', () => {
    const file = join(dir, 'exclude');
    writeFileSync(file, '# git ls-files --others --exclude-from=.git/info/exclude\n*.swp');
    expect(ensureFactoryExcluded(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe(
      '# git ls-files --others --exclude-from=.git/info/exclude\n*.swp\n.factory/\n',
    );
  });

  it('leaves the file alone when the entry is already present', () => {
    const file = join(dir, 'exclude');
    writeFileSync(file, '.factory/\n');
    expect(ensureFactoryExcluded(file)).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe('.factory/\n');
  });

  it('rethrows read errors other than ENOENT', () => {
    const file = join(dir, 'exclude');
    mkdirSync(file);
    expect(() => ensureFactoryExcluded(file)).toThrow(/EISDIR/);
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
