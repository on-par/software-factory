import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { h, installCliCommandsHarness, paths, runMain } from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('filing preview (#1858)', () => {
    it('resolves the factory commit through the injected exec seam, not node:child_process (#2014)', async () => {
      // h.repoRoot doubles as the factory checkout: the shell fake answers every
      // `git rev-parse --show-toplevel` with it, so resolveFactoryCheckoutCommit
      // finds the CLI package.json there and then asks the seam for HEAD.
      mkdirSync(join(h.repoRoot, 'packages', 'cli'), { recursive: true });
      writeFileSync(
        join(h.repoRoot, 'packages', 'cli', 'package.json'),
        JSON.stringify({ name: '@on-par/factory-cli' }),
      );
      const cmds: string[] = [];
      h.execImpl = (cmd: string) => {
        cmds.push(cmd);
        if (cmd.includes('rev-parse --show-toplevel')) return h.repoRoot;
        if (cmd.includes('rev-parse HEAD')) return 'c0ffee2014\n';
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      writeFileSync(
        paths().events,
        JSON.stringify({
          ts: '2026-01-01T00:00:00Z',
          type: 'park',
          issue: '77',
          fingerprint: 'fp-2014-shell-seam',
          evidence: {
            issue: '77',
            phase: 'build',
            model: 'claude-sonnet',
            reason: 'unknown',
            component: 'claude',
            origin: 'factory-internal',
            eventExcerpt: 'Error: boom',
            logPath: '/tmp/x.log',
          },
        }) + '\n',
      );
      const outWritten: string[] = [];
      const errWritten: string[] = [];
      const out = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk) => (outWritten.push(String(chunk)), true));
      const err = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((chunk) => (errWritten.push(String(chunk)), true));
      try {
        const res = await runMain('filing', 'preview', 'fp-2014-shell-seam');
        expect(res.exited).toBe(false);
        const written = outWritten.join('');
        expect(written).toContain('fp:fp-2014-shell-seam');
        expect(written).toContain('c0ffee2014');
        expect(cmds).toContain('git rev-parse HEAD');
        expect(errWritten.join('')).toContain('Preview only — nothing was sent.');
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
    });
  });
});
