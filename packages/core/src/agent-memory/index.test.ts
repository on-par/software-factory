import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { AGENT_MEMORY_DIR, agentMemoryPath, readAgentMemory, renderAgentMemory, scanAgentMemory } from './index.js';

const tmp = createTempDirs();
async function root(): Promise<string> {
  const d = await tmp.make('agent-memory-');
  await mkdir(join(d, AGENT_MEMORY_DIR), { recursive: true });
  return d;
}

afterEach(async () => {
  await tmp.cleanup();
});

describe('readAgentMemory', () => {
  it("readAgentMemory returns absent and renderAgentMemory returns '' when the file does not exist", async () => {
    const r = await readAgentMemory(await root(), 'alpha');
    expect(r.kind).toBe('absent');
    expect(renderAgentMemory(r)).toBe('');
  });

  it('loads a present file and renders it as untrusted lane memory', async () => {
    const d = await root();
    await writeFile(agentMemoryPath(d, 'alpha'), 'Never touch the legacy importer.\n');
    const r = await readAgentMemory(d, 'alpha');
    expect(r).toMatchObject({ kind: 'loaded', lane: 'alpha', content: 'Never touch the legacy importer.\n' });
    const out = renderAgentMemory(r);
    expect(out).toContain('## Lane memory (alpha)');
    expect(out).toContain('.factory/agent-memory/alpha.md');
    expect(out).toContain('<lane-memory>\nNever touch the legacy importer.\n</lane-memory>');
  });

  it('treats empty or whitespace content as absent', async () => {
    const d = await root();
    await writeFile(agentMemoryPath(d, 'alpha'), '  \n\n');
    expect((await readAgentMemory(d, 'alpha')).kind).toBe('absent');
  });

  it('loads exactly 4096 bytes and flags 4097 as oversized without content', async () => {
    const d = await root();
    await writeFile(agentMemoryPath(d, 'alpha'), 'x'.repeat(4096));
    expect((await readAgentMemory(d, 'alpha')).kind).toBe('loaded');
    await writeFile(agentMemoryPath(d, 'alpha'), 'x'.repeat(4097));
    const r = await readAgentMemory(d, 'alpha');
    expect(r).toEqual({ kind: 'oversized', path: agentMemoryPath(d, 'alpha'), bytes: 4097, maxBytes: 4096 });
    expect(renderAgentMemory(r)).toBe('');
  });

  it('reports a directory at the path as unreadable', async () => {
    const d = await root();
    await mkdir(agentMemoryPath(d, 'alpha'));
    const r = await readAgentMemory(d, 'alpha');
    expect(r.kind).toBe('unreadable');
    expect(renderAgentMemory(r)).toBe('');
  });
});

describe('agentMemoryPath', () => {
  it('keeps a hostile lane name inside the memory directory', () => {
    const p = agentMemoryPath('/repo', 'Night Shift/../x');
    expect(relative('/repo/.factory/agent-memory', p)).toMatch(/^[a-z0-9-]+\.md$/);
  });
});

describe('scanAgentMemory', () => {
  it('returns [] for a missing directory', async () => {
    const d = await tmp.make('agent-memory-');
    expect(await scanAgentMemory(d)).toEqual([]);
  });

  it('flags oversized .md files, ignores others, sorts by name', async () => {
    const d = await root();
    await writeFile(join(d, AGENT_MEMORY_DIR, 'b.md'), 'x'.repeat(5000));
    await writeFile(join(d, AGENT_MEMORY_DIR, 'a.md'), 'ok');
    await writeFile(join(d, AGENT_MEMORY_DIR, 'notes.txt'), 'ignored');
    await mkdir(join(d, AGENT_MEMORY_DIR, 'dir.md'));
    expect(await scanAgentMemory(d)).toEqual([
      { file: '.factory/agent-memory/a.md', bytes: 2, oversized: false },
      { file: '.factory/agent-memory/b.md', bytes: 5000, oversized: true },
    ]);
  });
});
