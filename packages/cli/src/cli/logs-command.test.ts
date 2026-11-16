import { writeFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { installCliCommandsHarness, paths, runMain } from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('logs', () => {
    it('prints existing events for the non-follow path', async () => {
      writeFileSync(
        paths().events,
        [JSON.stringify({ ts: '', type: 'plan', issue: '1', msg: 'Starting plan phase' })].join('\n'),
      );
      const out: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true));
      try {
        const res = await runMain('logs');
        expect(res.exited).toBe(false);
        expect(out.join('')).toContain('[factory] plan #1: Starting plan phase');
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('filters by --issue', async () => {
      writeFileSync(
        paths().events,
        [
          JSON.stringify({ ts: '', type: 'plan', issue: '296', msg: 'a' }),
          JSON.stringify({ ts: '', type: 'plan', issue: '301', msg: 'b' }),
        ].join('\n'),
      );
      const chunks: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (chunks.push(String(chunk)), true));
      try {
        await runMain('logs', '--issue', '296');
        expect(chunks.join('')).toContain('#296');
        expect(chunks.join('')).not.toContain('#301');
      } finally {
        spy.mockRestore();
      }
    });
  });
});
