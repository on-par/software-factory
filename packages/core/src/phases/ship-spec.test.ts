import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { specPaths } from '../spec/index.js';
import { readReadinessNotes } from './ship-spec.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

async function specWithNotes(content: string): Promise<string> {
  const dir = await tempDirs.make('ship-spec-readiness-');
  const specPath = join(dir, 'issue-7.md');
  await writeFile(specPaths(specPath).readiness, content);
  return specPath;
}

const NONE = { assumptions: [], questions: [] };

describe('readReadinessNotes (#3470)', () => {
  it('returns the assumptions and questions as aspect-tagged lines', async () => {
    const specPath = await specWithNotes(
      JSON.stringify({
        verdict: 'not-ready',
        summary: 'unclear',
        assumptions: [{ aspect: 'scope', text: 'Only the v2 API.' }],
        questions: [
          { aspect: 'decision', text: 'Keep the old flag?' },
          { aspect: 'acceptance', text: 'What is done?' },
        ],
      }),
    );
    await expect(readReadinessNotes(specPath)).resolves.toEqual({
      assumptions: ['[scope] Only the v2 API.'],
      questions: ['[decision] Keep the old flag?', '[acceptance] What is done?'],
    });
  });

  it('treats absent questions as none', async () => {
    const specPath = await specWithNotes(
      JSON.stringify({
        verdict: 'ready-with-assumptions',
        summary: 's',
        assumptions: [{ aspect: 'other', text: 'A.' }],
      }),
    );
    await expect(readReadinessNotes(specPath)).resolves.toEqual({ assumptions: ['[other] A.'], questions: [] });
  });

  it('returns no notes without a spec path, without the file, or for an unreadable file', async () => {
    await expect(readReadinessNotes(undefined)).resolves.toEqual(NONE);
    const dir = await tempDirs.make('ship-spec-readiness-');
    await expect(readReadinessNotes(join(dir, 'issue-8.md'))).resolves.toEqual(NONE);
    await expect(readReadinessNotes(await specWithNotes('{not json'))).resolves.toEqual(NONE);
    await expect(readReadinessNotes(await specWithNotes('{"verdict":"maybe","assumptions":[]}'))).resolves.toEqual(
      NONE,
    );
  });
});
