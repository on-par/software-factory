import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { InvalidWorkRequestInputError } from './index.js';
import { type BriefFileReader, createFsBriefReader, createLocalBriefAdapter } from './local-brief.js';

const VALID_BRIEF = `# Add a widget

Please add a widget that does the thing.

## Acceptance criteria

- [ ] the widget exists
- tests pass
`;

function fakeReader(content: string): BriefFileReader {
  return { readFile: async () => content };
}

const tempDirs: string[] = [];
function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-brief-'));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('createLocalBriefAdapter', () => {
  it('parses a valid brief into a WorkRequest', async () => {
    const suppliedPath = 'brief.md';
    const adapter = createLocalBriefAdapter(fakeReader(VALID_BRIEF));

    const request = await adapter.resolve({ path: suppliedPath });

    expect(request.kind).toBe('local-brief');
    expect(request.title).toBe('Add a widget');
    expect(request.brief.startsWith('Please add a widget')).toBe(true);
    expect(request.brief).not.toContain('# Add a widget');
    expect(request.acceptanceCriteria).toEqual(['the widget exists', 'tests pass']);

    const digest = createHash('sha256').update(VALID_BRIEF).digest('hex');
    expect(request.id).toBe(`local-brief:${suppliedPath}#${digest.slice(0, 12)}`);
    expect(request.reference?.externalId).toBe(digest);
    expect(request.reference?.externalId).toHaveLength(64);
    expect(request.reference?.url?.startsWith('file://')).toBe(true);
  });

  it('is deterministic — resolving the same content twice yields identical id and externalId', async () => {
    const adapter = createLocalBriefAdapter(fakeReader(VALID_BRIEF));

    const first = await adapter.resolve({ path: 'brief.md' });
    const second = await adapter.resolve({ path: 'brief.md' });

    expect(second.id).toBe(first.id);
    expect(second.reference?.externalId).toBe(first.reference?.externalId);
  });

  it.each([undefined, {}, { path: '' }, { path: 42 }])('rejects bad params: %j', async (params) => {
    const adapter = createLocalBriefAdapter(fakeReader(VALID_BRIEF));

    await expect(adapter.resolve(params)).rejects.toBeInstanceOf(InvalidWorkRequestInputError);
    try {
      await adapter.resolve(params);
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidWorkRequestInputError);
      const invalid = err as InvalidWorkRequestInputError;
      expect(invalid.kind).toBe('local-brief');
      expect(invalid.message).toContain('expected { path:');
    }
  });

  it('rejects a document with no "# " heading', async () => {
    const adapter = createLocalBriefAdapter(fakeReader('Please add a widget.\n\n## Acceptance criteria\n\n- a\n'));

    await expect(adapter.resolve({ path: 'brief.md' })).rejects.toThrow(/no title/);
  });

  it('rejects a title-only document', async () => {
    const adapter = createLocalBriefAdapter(fakeReader('# Add a widget\n\n   \n'));

    await expect(adapter.resolve({ path: 'brief.md' })).rejects.toThrow(/no task content/);
  });

  it('rejects a brief with no acceptance-criteria section', async () => {
    const adapter = createLocalBriefAdapter(fakeReader('# Add a widget\n\nPlease add a widget that does the thing.\n'));

    await expect(adapter.resolve({ path: 'brief.md' })).rejects.toThrow(/no acceptance criteria/);
  });

  it('rejects a brief with a present but empty acceptance-criteria section', async () => {
    const adapter = createLocalBriefAdapter(
      fakeReader('# Add a widget\n\nPlease add a widget that does the thing.\n\n## Acceptance criteria\n\n'),
    );

    await expect(adapter.resolve({ path: 'brief.md' })).rejects.toThrow(/no acceptance criteria/);
  });

  it('reads a real file from disk with the default fs reader', async () => {
    const path = tempFile('brief.md', VALID_BRIEF);
    const adapter = createLocalBriefAdapter();

    const request = await adapter.resolve({ path });

    expect(request.title).toBe('Add a widget');
  });

  it('bubbles a non-InvalidWorkRequestInputError for a missing file', async () => {
    const adapter = createLocalBriefAdapter(createFsBriefReader());

    await expect(adapter.resolve({ path: '/definitely/does/not/exist/brief.md' })).rejects.not.toBeInstanceOf(
      InvalidWorkRequestInputError,
    );
  });
});
