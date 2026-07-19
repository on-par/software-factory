import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applySteering,
  describeSteering,
  drainSteering,
  extractPathCandidates,
  listQueuedSteering,
  MAX_ATTACHMENT_BYTES,
  queueSteeringMessage,
  steeringFileFor,
} from './index.js';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'steering-'));
}

describe('queueSteeringMessage / listQueuedSteering', () => {
  it('round-trips fields and preserves queue order', () => {
    const dir = makeDir();
    try {
      const first = queueSteeringMessage(dir, 5, 'use approach A');
      const second = queueSteeringMessage(dir, 5, 'also check packages/core/src/utils/lock.ts');

      const messages = listQueuedSteering(dir, 5);
      expect(messages).toEqual([first, second]);
      expect(messages[0].id).toEqual(expect.any(String));
      expect(new Date(messages[0].queuedAt).toISOString()).toBe(messages[0].queuedAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] when the directory does not exist', () => {
    expect(listQueuedSteering(join(tmpdir(), 'steering-does-not-exist-xyz'), 5)).toEqual([]);
  });

  it('returns [] when the file does not exist but the dir does', () => {
    const dir = makeDir();
    try {
      expect(listQueuedSteering(dir, 999)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips malformed NDJSON lines', () => {
    const dir = makeDir();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        steeringFileFor(dir, 5),
        `${JSON.stringify({ id: '1', issue: 5, text: 'ok', queuedAt: '2026-01-01T00:00:00.000Z' })}\n{not json\n`,
      );
      const messages = listQueuedSteering(dir, 5);
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('drainSteering', () => {
  it('returns queued messages and deletes the queue file', () => {
    const dir = makeDir();
    const worktree = makeDir();
    try {
      queueSteeringMessage(dir, 5, 'do the thing');
      const drained = drainSteering(dir, 5, worktree);
      expect(drained.messages).toHaveLength(1);
      expect(drained.messages[0].text).toBe('do the thing');
      expect(listQueuedSteering(dir, 5)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('returns empty on a missing queue file (no race)', () => {
    const dir = makeDir();
    const worktree = makeDir();
    try {
      expect(drainSteering(dir, 5, worktree)).toEqual({ messages: [], attachments: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('a second drain in a row returns empty', () => {
    const dir = makeDir();
    const worktree = makeDir();
    try {
      queueSteeringMessage(dir, 5, 'first');
      drainSteering(dir, 5, worktree);
      expect(drainSteering(dir, 5, worktree)).toEqual({ messages: [], attachments: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('a message queued after a drain is returned by the next drain', () => {
    const dir = makeDir();
    const worktree = makeDir();
    try {
      queueSteeringMessage(dir, 5, 'first');
      drainSteering(dir, 5, worktree);
      queueSteeringMessage(dir, 5, 'second');
      const drained = drainSteering(dir, 5, worktree);
      expect(drained.messages).toHaveLength(1);
      expect(drained.messages[0].text).toBe('second');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('attaches content of a real referenced file', () => {
    const dir = makeDir();
    const worktree = makeDir();
    try {
      mkdirSync(join(worktree, 'packages', 'core', 'src', 'utils'), { recursive: true });
      writeFileSync(join(worktree, 'packages', 'core', 'src', 'utils', 'lock.ts'), 'export const x = 1;\n');
      queueSteeringMessage(dir, 5, 'please check packages/core/src/utils/lock.ts for the fix');

      const drained = drainSteering(dir, 5, worktree);
      expect(drained.attachments).toHaveLength(1);
      expect(drained.attachments[0]).toMatchObject({
        path: 'packages/core/src/utils/lock.ts',
        content: 'export const x = 1;\n',
        truncated: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('truncates attachments over MAX_ATTACHMENT_BYTES', () => {
    const dir = makeDir();
    const worktree = makeDir();
    try {
      const big = 'a'.repeat(MAX_ATTACHMENT_BYTES + 1000);
      writeFileSync(join(worktree, 'big.txt'), big);
      // extractPathCandidates requires a '/' — nest it one directory deep.
      mkdirSync(join(worktree, 'sub'), { recursive: true });
      writeFileSync(join(worktree, 'sub', 'big.txt'), big);
      queueSteeringMessage(dir, 5, 'see sub/big.txt');

      const drained = drainSteering(dir, 5, worktree);
      expect(drained.attachments).toHaveLength(1);
      expect(drained.attachments[0].truncated).toBe(true);
      expect(drained.attachments[0].content).toHaveLength(MAX_ATTACHMENT_BYTES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('does not attach a non-existent path but still consumes the message', () => {
    const dir = makeDir();
    const worktree = makeDir();
    try {
      queueSteeringMessage(dir, 5, 'check packages/does/not/exist.ts');
      const drained = drainSteering(dir, 5, worktree);
      expect(drained.messages).toHaveLength(1);
      expect(drained.attachments).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('never attaches absolute paths or paths with a ".." segment', () => {
    const dir = makeDir();
    const worktree = makeDir();
    try {
      queueSteeringMessage(dir, 5, 'look at /etc/passwd and also ../outside/evil.txt');

      const drained = drainSteering(dir, 5, worktree);
      expect(drained.attachments).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('dedupes a path referenced by two different messages', () => {
    const dir = makeDir();
    const worktree = makeDir();
    try {
      writeFileSync(join(worktree, 'shared.ts'), 'x');
      mkdirSync(join(worktree, 'sub'), { recursive: true });
      writeFileSync(join(worktree, 'sub', 'shared.ts'), 'shared content');
      queueSteeringMessage(dir, 5, 'first mention of sub/shared.ts');
      queueSteeringMessage(dir, 5, 'second mention of sub/shared.ts');

      const drained = drainSteering(dir, 5, worktree);
      expect(drained.messages).toHaveLength(2);
      expect(drained.attachments).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});

describe('extractPathCandidates', () => {
  it('finds no candidates in plain prose', () => {
    expect(extractPathCandidates('just use a better approach here')).toEqual([]);
  });

  it('finds a repo-relative path', () => {
    expect(extractPathCandidates('check packages/core/src/utils/lock.ts please')).toEqual([
      'packages/core/src/utils/lock.ts',
    ]);
  });

  it('strips trailing punctuation-adjacent quoting/parens', () => {
    expect(extractPathCandidates('see (packages/core/src/index.ts) and `packages/tui/src/index.ts`')).toEqual([
      'packages/core/src/index.ts',
      'packages/tui/src/index.ts',
    ]);
  });

  it('rejects absolute paths', () => {
    expect(extractPathCandidates('look at /etc/passwd')).toEqual([]);
  });

  it('rejects paths with a ".." traversal segment', () => {
    expect(extractPathCandidates('see ../../etc/passwd')).toEqual([]);
  });
});

describe('applySteering', () => {
  it('returns the identical string when steering is undefined', () => {
    const prompt = 'the original prompt';
    expect(applySteering(prompt)).toBe(prompt);
  });

  it('returns the identical string when there are no messages', () => {
    const prompt = 'the original prompt';
    expect(applySteering(prompt, { messages: [], attachments: [] })).toBe(prompt);
  });

  it('appends a guidance block with message text and timestamp', () => {
    const result = applySteering('base prompt', {
      messages: [{ id: '1', issue: 5, text: 'prefer approach B', queuedAt: '2026-01-01T00:00:00.000Z' }],
      attachments: [],
    });
    expect(result).toContain('base prompt');
    expect(result).toContain('## Operator guidance (steering)');
    expect(result).toContain('prefer approach B');
    expect(result).toContain('2026-01-01T00:00:00.000Z');
  });

  it('appends attached file content fenced under an Attached files heading', () => {
    const result = applySteering('base prompt', {
      messages: [{ id: '1', issue: 5, text: 'see it', queuedAt: '2026-01-01T00:00:00.000Z' }],
      attachments: [{ path: 'packages/core/src/index.ts', content: 'export {}', truncated: false }],
    });
    expect(result).toContain('### Attached files');
    expect(result).toContain('#### packages/core/src/index.ts');
    expect(result).toContain('export {}');
    expect(result).not.toContain('packages/core/src/index.ts (truncated)');
  });

  it('marks truncated attachments with a suffix', () => {
    const result = applySteering('base prompt', {
      messages: [{ id: '1', issue: 5, text: 'see it', queuedAt: '2026-01-01T00:00:00.000Z' }],
      attachments: [{ path: 'big.txt', content: 'a'.repeat(10), truncated: true }],
    });
    expect(result).toContain('#### big.txt (truncated)');
  });
});

describe('describeSteering', () => {
  it('formats consumed message ids and attached paths', () => {
    const description = describeSteering({
      messages: [
        { id: 'id-1', issue: 5, text: 'a', queuedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'id-2', issue: 5, text: 'b', queuedAt: '2026-01-01T00:00:01.000Z' },
      ],
      attachments: [{ path: 'packages/core/src/utils/lock.ts', content: '', truncated: false }],
    });
    expect(description).toBe('applied 2 steering message(s) [id-1, id-2]; attached: packages/core/src/utils/lock.ts');
  });

  it('reports "none" when there are no attachments', () => {
    const description = describeSteering({
      messages: [{ id: 'id-1', issue: 5, text: 'a', queuedAt: '2026-01-01T00:00:00.000Z' }],
      attachments: [],
    });
    expect(description).toBe('applied 1 steering message(s) [id-1]; attached: none');
  });
});
