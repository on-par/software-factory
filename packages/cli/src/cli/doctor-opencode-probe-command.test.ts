// packages/cli/src/cli/doctor-opencode-probe-command.test.ts — factory doctor --probe-inference OpenCode dispatch (#2892)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { coreFakes, h, installDoctorHarness, logged, runMainWith } from './test-support/doctor-harness.js';

installDoctorHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('cli doctor', () => {
  beforeEach(() => {
    vi.stubEnv('CODEX_HOME', join(h.repoRoot, 'no-codex-home'));
    mkdirSync(join(h.repoRoot, 'no-claude-config'), { recursive: true });
    mkdirSync(join(h.repoRoot, 'no-xdg-data'), { recursive: true });
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(h.repoRoot, 'no-claude-config'));
    vi.stubEnv('XDG_DATA_HOME', join(h.repoRoot, 'no-xdg-data'));
    for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY', 'OPENCODE_API_KEY']) {
      vi.stubEnv(key, '');
    }
    writeFileSync(join(h.repoRoot, 'no-claude-config', '.credentials.json'), '{}');
    h.execSyncImpl = (cmd: string) => {
      if (cmd.includes('rev-parse')) return h.repoRoot;
      if (cmd.includes('status --porcelain')) return '';
      if (cmd.includes('git config user.name')) return 'Test User';
      if (cmd.includes('git config user.email')) return 'test@example.com';
      if (cmd.includes('gh auth token')) return 'gho_token';
      if (cmd.includes('gh auth status')) return 'Logged in';
      return '';
    };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('opencode live auth probe (#2892)', () => {
    const textEvent = JSON.stringify({ type: 'text', part: { text: 'ok' } });
    const errEvent = JSON.stringify({
      type: 'error',
      error: { name: 'APIError', data: { message: 'Unauthorized', statusCode: 401 } },
    });
    const stub = (onOpencode: () => string) => {
      const recorded: string[] = [];
      const base = h.execSyncImpl;
      h.execSyncImpl = (cmd: string) => {
        recorded.push(cmd);
        return cmd.startsWith('opencode run') ? onOpencode() : base(cmd);
      };
      return recorded;
    };

    it('reports opencode auth (live) ok when the probe returns a text event', async () => {
      h.claudeAvailable = true;
      stub(() => textEvent);
      await runMain('doctor', '--probe-inference');
      expect(logged()).toContain('opencode auth (live)');
      expect(logged()).toContain('opencode run succeeded');
    });

    it('fails opencode auth (live) with fix opencode auth login on a 401 error event', async () => {
      h.claudeAvailable = true;
      stub(() => {
        throw Object.assign(new Error('exit 1'), { status: 1, stdout: errEvent });
      });
      await runMain('doctor', '--probe-inference');
      expect(logged()).toContain('opencode rejected the stored credential');
      expect(logged()).toContain('opencode auth login');
    });

    it('runs opencode run only with --probe-inference', async () => {
      h.claudeAvailable = true;
      const recorded = stub(() => textEvent);
      await runMain('doctor');
      expect(recorded.filter((c) => c.startsWith('opencode run'))).toEqual([]);
      await runMain('doctor', '--probe-inference');
      expect(recorded.filter((c) => c.startsWith('opencode run'))).toHaveLength(1);
    });

    it('fails opencode auth (live) with timed out and still prints the report when the probe hangs', async () => {
      h.claudeAvailable = true;
      stub(() => {
        throw Object.assign(new Error('spawnSync /bin/sh ETIMEDOUT'), { code: 'ETIMEDOUT' });
      });
      await runMain('doctor', '--probe-inference');
      expect(logged()).toContain('timed out');
      expect(logged()).toContain('STOP sentinel');
    });

    it('skips the probe when opencode is not on PATH', async () => {
      h.claudeAvailable = true;
      coreFakes.isCommandAvailable.mockImplementation((c: string) => c !== 'opencode');
      const recorded = stub(() => textEvent);
      await runMain('doctor', '--probe-inference');
      expect(logged()).toContain('skipped: opencode CLI not on PATH');
      expect(recorded.filter((c) => c.startsWith('opencode run'))).toEqual([]);
    });
  });
});
