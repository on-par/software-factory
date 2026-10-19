import { describe, expect, it } from 'vitest';

import type { FactoryConfig } from '../config/index.js';
import { buildDarwinProfile, resolveSandboxPolicy } from './index.js';

const sandbox: FactoryConfig['sandbox'] = {
  enabled: true,
  runtime: 'sandbox-exec',
  network: { allow: ['github.com'] },
  resources: { cpuMs: 300_000, memMb: 4096 },
  docker: { rolloutPercent: 0 },
};

describe('outer sandbox factory state path', () => {
  it('lets PLAN write a relocated state directory without granting the checkout root', () => {
    const state = '/srv/relocated factory/state';
    const policy = resolveSandboxPolicy(sandbox, {
      repoRoot: '/Users/agent/primary-repo',
      worktree: '/Users/agent/issue-worktree',
      factoryStateDir: state,
      env: {},
      platform: 'darwin',
      isAvailable: () => true,
      homedir: '/Users/agent',
      tmpdir: '/tmp',
    });
    expect(policy?.writablePaths).toContain(state);
    expect(policy?.writablePaths).not.toContain('/Users/agent/primary-repo');
    expect(buildDarwinProfile(policy!)).toContain(`(allow file-write* (subpath "${state}"))`);
  });

  it('rejects a configured state root that contains the checkout', () => {
    const policy = resolveSandboxPolicy(sandbox, {
      repoRoot: '/Users/agent/primary-repo',
      worktree: '/Users/agent/issue-worktree',
      factoryStateDir: '/Users/agent',
      env: {},
      platform: 'darwin',
      isAvailable: () => true,
      homedir: '/Users/agent',
      tmpdir: '/tmp',
    });
    expect(policy?.writablePaths).not.toContain('/Users/agent');
  });
});
