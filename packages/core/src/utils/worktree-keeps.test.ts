import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { findWorktreeKeep, readWorktreeKeeps, removeWorktreeKeep, upsertWorktreeKeep } from './worktree-keeps.js';

describe('worktree-keeps store', () => {
  let dir: string;
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'keeps-'));
    return join(dir, 'state', 'worktree-keeps.json');
  };
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const keep = (issue: number, reason = 'budget_exceeded') => ({ issue, path: `/wt/${issue}`, reason, since: 'now' });

  it('reads a missing file as empty with no log', () => {
    const file = setup();
    const log = vi.fn();
    expect(readWorktreeKeeps(file, log)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('upserts, then replaces by issue without duplicating', () => {
    const file = setup();
    upsertWorktreeKeep(file, keep(1));
    upsertWorktreeKeep(file, keep(2));
    upsertWorktreeKeep(file, keep(1, 'other'));
    expect(readWorktreeKeeps(file)).toEqual([keep(2), keep(1, 'other')]);
    expect(findWorktreeKeep(file, 1)?.reason).toBe('other');
    expect(findWorktreeKeep(file, 9)).toBeUndefined();
  });

  it('removes one issue and leaves the others; an absent issue never creates the file', () => {
    const file = setup();
    removeWorktreeKeep(file, 1);
    expect(existsSync(file)).toBe(false);
    upsertWorktreeKeep(file, keep(1));
    upsertWorktreeKeep(file, keep(2));
    removeWorktreeKeep(file, 1);
    expect(readWorktreeKeeps(file)).toEqual([keep(2)]);
    removeWorktreeKeep(file, 7);
    expect(readWorktreeKeeps(file)).toEqual([keep(2)]);
  });

  it.each(['{not json', '{"issue":1}'])('warns exactly once and reads empty for %s', (content) => {
    const file = setup();
    upsertWorktreeKeep(file, keep(1));
    writeFileSync(file, content);
    const log = vi.fn();
    expect(readWorktreeKeeps(file, log)).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe('warn');
  });

  it('drops entries with bad fields', () => {
    const file = setup();
    upsertWorktreeKeep(file, keep(1));
    writeFileSync(
      file,
      JSON.stringify([keep(1), { issue: '2', path: 'p', reason: 'r', since: 's' }, null, { issue: 3 }]),
    );
    expect(readWorktreeKeeps(file)).toEqual([keep(1)]);
  });

  it('leaves no temp file after a write', () => {
    const file = setup();
    upsertWorktreeKeep(file, keep(1));
    expect(readdirSync(join(dir, 'state'))).toEqual(['worktree-keeps.json']);
  });
});
