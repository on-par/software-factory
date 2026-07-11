import { describe, expect, it } from 'vitest';
import { withGitLock } from './lock.js';

const delay = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

describe('withGitLock', () => {
  it('serializes work for the same key', async () => {
    const key = 'same-key';
    const order: string[] = [];
    let active = 0;
    let peakActive = 0;

    const first = withGitLock(key, async () => {
      active++;
      peakActive = Math.max(peakActive, active);
      order.push('first:start');
      await delay();
      order.push('first:end');
      active--;
    });

    const second = withGitLock(key, async () => {
      active++;
      peakActive = Math.max(peakActive, active);
      order.push('second:start');
      await delay();
      order.push('second:end');
      active--;
    });

    await Promise.all([first, second]);

    expect(peakActive).toBe(1);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('releases the lock when work throws', async () => {
    const key = 'throw-key';

    await expect(withGitLock(key, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    let ran = false;
    await expect(withGitLock(key, async () => {
      ran = true;
      return 'ok';
    })).resolves.toBe('ok');

    expect(ran).toBe(true);
  });

  it('allows different keys to run concurrently', async () => {
    let active = 0;
    let peakActive = 0;

    const run = async () => {
      active++;
      peakActive = Math.max(peakActive, active);
      await delay();
      active--;
    };

    await Promise.all([
      withGitLock('key-a', run),
      withGitLock('key-b', run),
    ]);

    expect(peakActive).toBe(2);
  });
});
