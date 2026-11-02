import { describe, expect, it } from 'vitest';

import { installCliCommandsHarness, logged, runMain } from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('overview (bare factory)', () => {
    it('prints the designed overview and does not call process.exit', async () => {
      const res = await runMain();
      expect(res.exited).toBe(false);
      const out = logged();
      expect(out).toContain('factory — ship verified GitHub issues autonomously');
      expect(out).toContain('factory ship <issue>');
    });
  });
});
