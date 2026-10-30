import { describe, expect, it, vi } from 'vitest';

import { errored, h, installCliCommandsHarness, logged, logSpy, runMain } from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('check / ready', () => {
    const COMPLETE_BODY = `### Problem statement

Something is wrong.

### In scope

Fix it.

### Out of scope

Nothing else.

### Acceptance criteria

- [ ] it works

### Verification

bash scripts/verify.sh
`;

    it('prints the ready line and exits 0 for a complete issue body', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix it', body: COMPLETE_BODY } }));
      const res = await runMain('ready', '421', '--no-judge');
      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('issue #421 is factory-ready (factory-task, score 100%)');
    });

    it('prints the missing fields and exits 1 for an incomplete issue body', async () => {
      const incompleteBody = COMPLETE_BODY.replace(/### Verification\n\nbash scripts\/verify\.sh\n/, '');
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix it', body: incompleteBody } }));
      const res = await runMain('ready', '421', '--no-judge');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toContain('missing: Verification');
      expect(errored()).toContain('issue #421 is not factory-ready — missing: Verification');
    });

    const bigBody = COMPLETE_BODY.replace(
      '- [ ] it works',
      Array.from({ length: 7 }, (_, i) => `- [ ] c${i}`).join('\n'),
    );

    it('check prints the runs-as-is size line and exits 0', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix it', body: COMPLETE_BODY } }));
      const res = await runMain('check', '421', '--no-judge');
      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('size: runs as-is');
    });

    it('exits 3 and says would split for an oversized issue', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix it', body: bigBody } }));
      const res = await runMain('check', '421', '--no-judge');
      expect(res).toEqual({ exited: true, code: 3 });
      expect(logged()).toContain('would split');
    });

    it('ready is an alias with identical output', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix it', body: COMPLETE_BODY } }));
      await runMain('check', '421', '--no-judge');
      const viaCheck = logged();
      logSpy.mockClear();
      await runMain('ready', '421', '--no-judge');
      expect(logged()).toBe(viaCheck);
    });

    it('--json prints one parseable object', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix it', body: COMPLETE_BODY } }));
      await runMain('check', '421', '--json', '--no-judge');
      expect(JSON.parse(logged())).toMatchObject({ issue: 421, exitCode: 0 });
    });

    it('exits 2 on an invalid issue argument', async () => {
      const res = await runMain('ready', 'abc');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
    });
  });
});
