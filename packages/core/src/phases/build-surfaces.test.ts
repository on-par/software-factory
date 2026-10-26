import { workKeyFromIssue } from '../work/work-key.js';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { lintChecker } from '../checkers/index.js';
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

describe('BUILD prompt lint surfaces (#2830)', () => {
  const lintPkg = '{"name":"fixture","version":"1.0.0","scripts":{"lint":"eslint ."}}';

  async function fixture(files: Record<string, string>): Promise<string> {
    const worktree = await mkdtemp(join(tmpdir(), 'build-surfaces-test-'));
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
      issue: workKeyFromIssue(2830),
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'issue-2830.md'),
      branch: 'factory/2830-x',
      route: 'claude',
      router,
      constitution: null,
      log: () => {},
    });
    expect(result.ok).toBe(true);
    return stub.calls[stub.calls.length - 1].prompt;
  }

  it('keeps scripts/verify.sh primary and renders no lint instruction when verify.sh exists', async () => {
    const worktree = await fixture({
      'package.json': lintPkg,
      'tsconfig.json': '{}',
      'scripts/verify.sh': '#!/bin/sh\n',
    });
    const prompt = await runPrompt(worktree);
    expect(prompt).toContain('bash scripts/verify.sh --no-e2e');
    for (const absent of ['`npm run lint`', '`npx tsc --noEmit`', 'Also run', 'lint checker']) {
      expect(prompt).not.toContain(absent);
    }
    const base = { issue: workKeyFromIssue(1), branch: 'b', specPath: '/s.md', constitutionCtx: '' };
    expect(buildClaudePrompt(base)).toBe(buildClaudePrompt({ ...base, lintCommands: [] }));
  });

  it('renders no lint-related text when the repo has no lint script and no tsconfig.json', async () => {
    const worktree = await fixture({
      'package.json': '{"name":"fixture","version":"1.0.0","scripts":{"test":"vitest"}}',
    });
    const prompt = await runPrompt(worktree);
    expect(prompt).not.toMatch(/lint/i);
    expect(prompt).not.toMatch(/\btsc\b/i);
    expect(
      buildCommitOnlyPrompt({ issue: workKeyFromIssue(1), specPath: 's', constitutionCtx: '', spec: '' }),
    ).not.toMatch(/lint/i);
    expect(
      buildClaudePrompt({ issue: workKeyFromIssue(1), branch: 'b', specPath: 's', constitutionCtx: '' }),
    ).not.toMatch(/lint/i);
  });

  it('drift guard: BUILD renders exactly the argv lintChecker runs', async () => {
    const worktree = await fixture({ 'package.json': lintPkg, 'tsconfig.json': '{}' });
    // Fake npm/npx record their argv instead of running, so the real lintChecker argv is observable.
    const bin = await mkdtemp(join(tmpdir(), 'build-surfaces-bin-'));
    tempDirs.add(bin);
    const log = join(bin, 'argv.log');
    for (const tool of ['npm', 'npx']) {
      const shim = join(bin, tool);
      await writeFile(shim, `#!/bin/sh\necho "${tool} $*" >> "${log}"\n`);
      await chmod(shim, 0o755);
    }
    await lintChecker({
      worktree,
      specPath: join(worktree, 'x.md'),
      constitutionBody: '',
      env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    const checkerCmds = (await readFile(log, 'utf8')).trim().split('\n');
    const prompt = await runPrompt(worktree);

    expect(checkerCmds).toEqual(['npm run lint', 'npx tsc --noEmit']);
    expect(prompt).toContain(`Also run ${checkerCmds.map((c) => `\`${c}\``).join(' and ')}`);
  });
});
