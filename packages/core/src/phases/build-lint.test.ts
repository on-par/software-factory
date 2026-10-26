import { workKeyFromIssue } from '../work/work-key.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveLintCommands } from '../checkers/index.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { buildClaudePrompt, buildCommitOnlyPrompt, buildPhase } from './build.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-worker': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { worker: ['stub-worker'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: { build_claude: { tier: 'worker', description: 'stub' } },
};

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('BUILD prompt lint and tsc rule (#2829)', () => {
  const lintPkg = '{"name":"fixture","version":"1.0.0","scripts":{"lint":"eslint ."}}';

  async function fixture(files: Record<string, string>): Promise<string> {
    const worktree = await mkdtemp(join(tmpdir(), 'build-lint-test-'));
    tempDirs.add(worktree);
    for (const [name, content] of Object.entries(files)) {
      await mkdir(join(worktree, name, '..'), { recursive: true });
      await writeFile(join(worktree, name), content);
    }
    return worktree;
  }

  async function runPrompt(worktree: string): Promise<string> {
    const stub = new StubModelExecutor({ scripts: { build_claude: [{ output: 'done' }] } });
    const router = new ModelRouter(models, routes, false, stub);
    const result = await buildPhase({
      issue: workKeyFromIssue(2829),
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'issue-2829.md'),
      branch: 'ship-it/2829-lint',
      route: 'claude',
      router,
      constitution: null,
      log: () => {},
    });
    expect(result.ok).toBe(true);
    return stub.calls[stub.calls.length - 1].prompt;
  }

  it('renders exactly the commands resolveLintCommands returns', async () => {
    const worktree = await fixture({ 'package.json': lintPkg, 'tsconfig.json': '{}' });
    const cmds = await resolveLintCommands({ worktree });
    expect(cmds.map((c) => c.argv.join(' '))).toEqual(['npm run lint', 'npx tsc --noEmit']);
    const expected = `Also run ${cmds.map((c) => `\`${c.argv.join(' ')}\``).join(' and ')}`;
    const base = { issue: workKeyFromIssue(1), specPath: '/s.md', constitutionCtx: '', lintCommands: cmds };
    for (const prompt of [
      buildCommitOnlyPrompt({ ...base, spec: 'spec' }),
      buildClaudePrompt({ ...base, branch: 'b' }),
    ]) {
      expect(prompt).toContain(expected);
      expect(prompt).toContain('fix their failures before finishing');
    }
  });

  it('buildPhase prompt names npm run lint when the repo has a lint script and no verify.sh', async () => {
    const prompt = await runPrompt(await fixture({ 'package.json': lintPkg }));
    expect(prompt).toContain('`npm run lint`');
    expect(prompt).toContain('fix their failures before finishing');
    expect(prompt).not.toContain('`npx tsc --noEmit`');
  });

  it('buildPhase prompt names npx tsc --noEmit when the repo has a tsconfig.json and no verify.sh', async () => {
    const prompt = await runPrompt(await fixture({ 'tsconfig.json': '{}' }));
    expect(prompt).toContain('`npx tsc --noEmit`');
    expect(prompt).toContain('fix their failures before finishing');
    expect(prompt).not.toContain('`npm run lint`');
  });

  it('omits the lint rule when scripts/verify.sh exists', async () => {
    const prompt = await runPrompt(
      await fixture({ 'package.json': lintPkg, 'tsconfig.json': '{}', 'scripts/verify.sh': '#!/bin/sh\n' }),
    );
    expect(prompt).not.toContain('Also run');
  });

  it('omits the lint rule without lint surfaces', () => {
    const base = { issue: workKeyFromIssue(1), specPath: '/s.md', constitutionCtx: '', spec: 'spec' };
    expect(buildCommitOnlyPrompt(base)).toBe(buildCommitOnlyPrompt({ ...base, lintCommands: [] }));
  });
});
