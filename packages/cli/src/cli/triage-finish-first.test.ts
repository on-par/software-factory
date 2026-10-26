import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyFinishBeforeStart } from './triage-finish-first.js';

const tmp = createTempDirs();
const cand = (number: number, body = '') => ({ number, title: `t${number}`, labels: [], body });
const open = [cand(1), cand(2), cand(20, 'Part of #2'), cand(12, 'Decomposed from #1')];
const queue = 'app 20\napp 12\n';

describe('applyFinishBeforeStart (#3109)', () => {
  let dir: string;
  let events: string;
  beforeEach(() => {
    dir = tmp.makeSync('triage-finish-first-');
    events = join(dir, 'events.jsonl');
  });
  afterEach(async () => tmp.cleanup());
  const logged = () => {
    try {
      return readFileSync(events, 'utf-8');
    } catch {
      return '';
    }
  };

  it('reorders and logs a triage event when a child of the parent is built', async () => {
    const cmds: string[] = [];
    const exec = async (cmd: string) => {
      cmds.push(cmd);
      return { stdout: JSON.stringify([{ number: 11, body: 'Decomposed from #1' }, { number: 'x' }]) };
    };
    const res = await applyFinishBeforeStart(queue, open, 'o/r', events, exec);
    expect(res.endsWith('app 12\napp 20\n')).toBe(true);
    expect(cmds[0]).toContain('--state closed');
    expect(logged()).toContain('Finish before start: #12');
  });

  it('returns the queue unchanged when no open parent has both built and unbuilt children', async () => {
    const exec = async () => ({ stdout: '[]' });
    expect(await applyFinishBeforeStart(queue, open, 'o/r', events, exec)).toBe(queue);
    expect(logged()).toBe('');
  });

  it('leaves the queue unchanged and warns when the fetch throws or is malformed', async () => {
    const boom = async (): Promise<{ stdout: string }> => {
      throw new Error('gh down');
    };
    expect(await applyFinishBeforeStart(queue, open, 'o/r', events, boom)).toBe(queue);
    expect(logged()).toContain('gh down');
    expect(await applyFinishBeforeStart(queue, open, 'o/r', events, async () => ({ stdout: '{}' }))).toBe(queue);
    expect(logged()).toContain('malformed');
  });

  it('does not call gh without parent references or for an empty queue', async () => {
    const exec = async (): Promise<{ stdout: string }> => {
      throw new Error('should not be called');
    };
    expect(await applyFinishBeforeStart(queue, [cand(1), cand(2)], 'o/r', events, exec)).toBe(queue);
    expect(await applyFinishBeforeStart('', open, 'o/r', events, exec)).toBe('');
    expect(logged()).toBe('');
  });
});
