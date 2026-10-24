import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConstitutionLoader } from './index.js';

describe('constitution affectedTestsFullOn frontmatter (#3260)', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('parses the globs and defaults to []', () => {
    dir = mkdtempSync(join(tmpdir(), 'const-'));
    writeFileSync(join(dir, 'a.md'), "---\nproduct: a\naffectedTestsFullOn:\n  - '*.proto'\n---\nBody\n");
    writeFileSync(join(dir, 'b.md'), '---\nproduct: b\n---\nBody\n');
    const loader = new ConstitutionLoader(dir);
    expect(loader.load('a').affectedTestsFullOn).toEqual(['*.proto']);
    expect(loader.load('b').affectedTestsFullOn).toEqual([]);
  });
});
