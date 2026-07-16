import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseQueue, readQueue, validateQueue } from './index.js';

const tempDirs: string[] = [];

function mkdtemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-queue-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('validateQueue', () => {
  it('accepts a valid queue', () => {
    const result = validateQueue('app 5\napp 6\ninfra 7\n');
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([5, 6, 7]);
    expect(result.errors).toEqual([]);
  });

  it('allows comments and a trailing blank line', () => {
    const result = validateQueue('# plan\napp 5\n# skip 9: vague\napp 6\n\n');
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([5, 6]);
  });

  it('rejects a blank line in the middle', () => {
    const result = validateQueue('app 5\n\napp 6\n');
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('line 2') && e.includes('empty line'))).toBe(true);
  });

  it('rejects malformed entries', () => {
    expect(validateQueue('app five\n').ok).toBe(false);
    expect(validateQueue('app five\n').errors.some((e) => e.includes('malformed'))).toBe(true);
    expect(validateQueue('justoneword\n').ok).toBe(false);
    expect(validateQueue('justoneword\n').errors.some((e) => e.includes('malformed'))).toBe(true);
  });

  it('rejects issue number 0', () => {
    const result = validateQueue('app 0\n');
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate issues but keeps the first parse', () => {
    const result = validateQueue('app 5\ninfra 5\n');
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('duplicate issue #5'))).toBe(true);
    expect(result.issues).toEqual([5]);
  });

  it('rejects empty or comment-only content', () => {
    expect(validateQueue('').ok).toBe(false);
    expect(validateQueue('').errors).toContain('queue has no issue entries');
    expect(validateQueue('# nothing\n').ok).toBe(false);
    expect(validateQueue('# nothing\n').errors).toContain('queue has no issue entries');
  });
});

describe('parseQueue', () => {
  it('parses a valid queue', () => {
    const result = parseQueue('app 5\napp 6\ninfra 7\n');
    expect(result.diagnostics).toEqual([]);
    expect(result.entries).toEqual([
      { lane: 'app', issue: 5, lineNo: 1 },
      { lane: 'app', issue: 6, lineNo: 2 },
      { lane: 'infra', issue: 7, lineNo: 3 },
    ]);
  });

  it('tolerates comments, blank lines (including mid-file), and surrounding whitespace', () => {
    const result = parseQueue('# plan\n\n  app 5  \n');
    expect(result.diagnostics).toEqual([]);
    expect(result.entries).toEqual([{ lane: 'app', issue: 5, lineNo: 3 }]);
  });

  it.each([['app abc\n'], ['justoneword\n'], ['app 0\n'], ['app 5 extra\n']])(
    'flags a malformed entry with a diagnostic: %s',
    (content) => {
      const result = parseQueue(content);
      expect(result.entries).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].lineNo).toBe(1);
      expect(result.diagnostics[0].message).toContain('malformed');
    },
  );

  it('skips malformed lines but keeps valid entries in a mixed file', () => {
    const result = parseQueue('# h\napp 1\nbad line here\napp 2\n');
    expect(result.entries.map((e) => e.issue)).toEqual([1, 2]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].lineNo).toBe(3);
  });

  it('keeps duplicate entries (dedup is an accept-time concern)', () => {
    const result = parseQueue('app 5\ninfra 5\n');
    expect(result.entries).toEqual([
      { lane: 'app', issue: 5, lineNo: 1 },
      { lane: 'infra', issue: 5, lineNo: 2 },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('returns empty entries and diagnostics for empty or comment-only content', () => {
    expect(parseQueue('')).toEqual({ entries: [], diagnostics: [] });
    expect(parseQueue('# nothing\n')).toEqual({ entries: [], diagnostics: [] });
  });

  it('never throws on arbitrary string input', () => {
    expect(() => parseQueue('\n\n')).not.toThrow();
    expect(() => parseQueue('app 99999999\n')).not.toThrow();
    expect(parseQueue('app 99999999\n').entries).toEqual([{ lane: 'app', issue: 99999999, lineNo: 1 }]);
  });
});

describe('readQueue', () => {
  it('returns empty entries and no proposedCount when the queue file is missing', () => {
    const dir = mkdtemp();
    expect(readQueue(join(dir, 'queue'))).toEqual({ entries: [] });
  });

  it('reads entries from an existing queue file', () => {
    const dir = mkdtemp();
    const queueFile = join(dir, 'queue');
    writeFileSync(queueFile, 'app 5\ninfra 6\n');
    expect(readQueue(queueFile)).toEqual({
      entries: [
        { lane: 'app', issue: 5 },
        { lane: 'infra', issue: 6 },
      ],
    });
  });

  it('sets proposedCount when a proposed queue file is given and exists', () => {
    const dir = mkdtemp();
    const queueFile = join(dir, 'queue');
    const proposedFile = join(dir, 'queue.proposed');
    writeFileSync(queueFile, 'app 5\n');
    writeFileSync(proposedFile, 'app 6\napp 7\n');
    expect(readQueue(queueFile, proposedFile)).toEqual({
      entries: [{ lane: 'app', issue: 5 }],
      proposedCount: 2,
    });
  });

  it('leaves proposedCount undefined when the proposed file is missing', () => {
    const dir = mkdtemp();
    const queueFile = join(dir, 'queue');
    writeFileSync(queueFile, 'app 5\n');
    expect(readQueue(queueFile, join(dir, 'queue.proposed'))).toEqual({
      entries: [{ lane: 'app', issue: 5 }],
    });
  });

  it('de-duplicates repeated issues in the accepted queue, keeping the first lane', () => {
    const dir = mkdtemp();
    const queueFile = join(dir, 'queue');
    writeFileSync(queueFile, 'app 5\ninfra 5\n');
    expect(readQueue(queueFile)).toEqual({ entries: [{ lane: 'app', issue: 5 }] });
  });

  it('tolerates leading whitespace on an otherwise well-formed entry', () => {
    const dir = mkdtemp();
    const queueFile = join(dir, 'queue');
    writeFileSync(queueFile, '  app 5\n\tinfra 6\n');
    expect(readQueue(queueFile)).toEqual({
      entries: [
        { lane: 'app', issue: 5 },
        { lane: 'infra', issue: 6 },
      ],
    });
  });
});
