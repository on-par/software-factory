import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '@on-par/factory-core/testing';
import { ConstitutionLoader } from './index.js';

describe('constitution affectedTestsFullOn frontmatter (#3260)', () => {
  const tempDirs = createTempDirs();
  afterEach(() => tempDirs.cleanup());

  it('parses the globs and defaults to []', () => {
    const dir = tempDirs.makeSync('const-');
    writeFileSync(join(dir, 'a.md'), "---\nproduct: a\naffectedTestsFullOn:\n  - '*.proto'\n---\nBody\n");
    writeFileSync(join(dir, 'b.md'), '---\nproduct: b\n---\nBody\n');
    const loader = new ConstitutionLoader(dir);
    expect(loader.load('a').affectedTestsFullOn).toEqual(['*.proto']);
    expect(loader.load('b').affectedTestsFullOn).toEqual([]);
  });
});
