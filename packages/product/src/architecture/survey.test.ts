// packages/product/src/architecture/survey.test.ts (#477).
import { createInMemoryReader } from '@on-par/repo-context';
import type { RepoContextReader } from '@on-par/repo-context';
import { describe, expect, it } from 'vitest';

import { surveyRepo } from './survey.js';

describe('surveyRepo', () => {
  it('lists directories under packages/ as components, sorted by name', async () => {
    const reader = createInMemoryReader({
      'packages/core/src/index.ts': 'export {}',
      'packages/cli/src/index.ts': 'export {}',
      'docs/adr/0001-x.md': 'x',
    });

    const survey = await surveyRepo(reader);

    expect(survey.components).toEqual([
      { name: 'cli', path: 'packages/cli' },
      { name: 'core', path: 'packages/core' },
    ]);
  });

  it('excludes files directly under packages/', async () => {
    const reader = createInMemoryReader({
      'packages/README.md': 'not a component',
      'packages/core/src/index.ts': 'export {}',
    });

    const survey = await surveyRepo(reader);

    expect(survey.components).toEqual([{ name: 'core', path: 'packages/core' }]);
  });

  it('returns [] components when packages/ is missing', async () => {
    const reader = createInMemoryReader({});

    const survey = await surveyRepo(reader);

    expect(survey.components).toEqual([]);
  });

  it('reports hasAdrHome true when docs/adr exists', async () => {
    const reader = createInMemoryReader({ 'docs/adr/0001-x.md': 'x' });

    expect((await surveyRepo(reader)).hasAdrHome).toBe(true);
  });

  it('reports hasAdrHome false when docs/adr is missing', async () => {
    const reader = createInMemoryReader({});

    expect((await surveyRepo(reader)).hasAdrHome).toBe(false);
  });

  it('honors custom packagesDir and adrDir', async () => {
    const reader = createInMemoryReader({
      'src-packages/widget/index.ts': 'export {}',
      'adr-home/0001-x.md': 'x',
    });

    const survey = await surveyRepo(reader, { packagesDir: 'src-packages', adrDir: 'adr-home' });

    expect(survey.components).toEqual([{ name: 'widget', path: 'src-packages/widget' }]);
    expect(survey.hasAdrHome).toBe(true);
  });

  it('sorts components by name regardless of comparator argument order', async () => {
    const reader: RepoContextReader = {
      readDir: async () => [
        { name: 'core', path: 'packages/core', type: 'dir' },
        { name: 'cli', path: 'packages/cli', type: 'dir' },
      ],
      readFile: async () => undefined,
      exists: async () => false,
    };

    const survey = await surveyRepo(reader);

    expect(survey.components).toEqual([
      { name: 'cli', path: 'packages/cli' },
      { name: 'core', path: 'packages/core' },
    ]);
  });

  it('breaks a tie between two components sharing a name by leaving sort order stable', async () => {
    const reader: RepoContextReader = {
      readDir: async () => [
        { name: 'dup', path: 'packages/dup', type: 'dir' },
        { name: 'dup', path: 'packages/other/dup', type: 'dir' },
      ],
      readFile: async () => undefined,
      exists: async () => false,
    };

    const survey = await surveyRepo(reader);

    expect(survey.components).toEqual([
      { name: 'dup', path: 'packages/dup' },
      { name: 'dup', path: 'packages/other/dup' },
    ]);
  });
});
