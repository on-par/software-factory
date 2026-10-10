// The agent CLIs run with bypassed permissions; none of them may inherit the
// factory's GitHub credentials. Drives each real harness through the real
// defaultExecFn against stand-in `claude` / `codex` / `opencode` binaries that
// report which GitHub credential variables they were spawned with.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeCliHarness } from './claude-cli.js';
import { CodexCliHarness } from './codex-cli.js';
import { makeContractRequest } from './contract.js';
import { OpenCodeHarness } from './opencode.js';

const LEAKED =
  'leaked=$(env | cut -d= -f1 | grep -E "^(GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$" | sort | tr "\\n" ",")';

const FAKE_BINARIES: Record<string, string> = {
  claude: `${LEAKED}\nprintf '{"type":"result","result":"leaked=%s"}\\n' "$leaked"\n`,
  codex: `${LEAKED}\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done\nprintf 'leaked=%s' "$leaked" > "$out"\n`,
  opencode: `${LEAKED}\nprintf 'leaked=%s' "$leaked"\n`,
};

describe.skipIf(process.platform === 'win32')('agent CLI harnesses never receive GitHub credentials', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factory-gh-isolation-'));
    for (const [name, body] of Object.entries(FAKE_BINARIES)) {
      const bin = join(dir, name);
      await writeFile(bin, `#!/bin/sh\n${body}`);
      await chmod(bin, 0o755);
    }
    vi.stubEnv('PATH', `${dir}:${process.env.PATH ?? ''}`);
    vi.stubEnv('GITHUB_TOKEN', 'ghp_isolationTokenValue0123456789');
    vi.stubEnv('GH_TOKEN', 'gh-token-opaque-value');
    vi.stubEnv('GITHUB_PAT', 'github-pat-opaque-value');
    vi.stubEnv('GH_ENTERPRISE_TOKEN', 'gh-enterprise-opaque');
    vi.stubEnv('GITHUB_ENTERPRISE_TOKEN', 'github-enterprise-opaque');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  const harnesses = {
    claude: () => new ClaudeCliHarness(),
    codex: () => new CodexCliHarness(),
    opencode: () => new OpenCodeHarness(),
  };

  for (const [name, make] of Object.entries(harnesses)) {
    it(`${name}: no GitHub token vars in the child env, with or without lane env`, async () => {
      const bare = await make().run(makeContractRequest({ worktree: dir }));
      const withLaneEnv = await make().run(
        makeContractRequest({ worktree: dir, env: { PORT: '3142', GITHUB_TOKEN: 'smuggled-in-lane-env' } }),
      );

      expect(bare.output.trim()).toBe('leaked=');
      expect(withLaneEnv.output.trim()).toBe('leaked=');
    });
  }

  it('the stand-ins do see the credentials when explicitly allowed (sanity check of the probe)', async () => {
    const { defaultExecFn } = await import('../utils/exec.js');

    const { stdout } = await defaultExecFn('opencode', { cwd: dir, githubAuth: true });

    expect(stdout).toBe('leaked=GH_ENTERPRISE_TOKEN,GH_TOKEN,GITHUB_ENTERPRISE_TOKEN,GITHUB_PAT,GITHUB_TOKEN,');
  });
});
