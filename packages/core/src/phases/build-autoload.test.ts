import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ConstitutionLoader } from '../constitutions/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { buildPhase } from './build.js';

const tmp = createTempDirs();

afterEach(() => tmp.cleanup());

describe('BUILD omits auto-loaded AGENTS.md (#1600)', () => {
  const MARK = 'AGENTS-MARK-1600';
  const mk = (harness: string, extra: Record<string, unknown> = {}): ModelsConfig['models'][string] => ({
    provider: 'custom',
    tier: 'worker',
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [],
    envKey: null,
    harness,
    ...extra,
  });
  const routesAll: RoutesConfig = {
    version: 1,
    routes: {
      build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
      build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
      build_opencode: { tier: 'worker', description: 'stub', requires: 'opencode' },
      build_command: { tier: 'worker', description: 'stub', requires: 'command' },
    },
  } as RoutesConfig;
  const cfg = (defs: ModelsConfig['models']): ModelsConfig => ({
    version: 1,
    models: defs,
    tiers: { worker: Object.keys(defs) },
    failover: { triggers: ['rate_limit', 'unavailable', 'auth'], maxRetries: 2, cooldownMs: 0 },
    routingRules: {},
  });
  const stdModels = cfg({
    'cx-a': mk('codex-cli', { codex: true, capabilities: ['codex'] }),
    'oc-a': mk('opencode'),
    'cl-a': mk('claude-cli'),
    'pi-a': mk('pi'),
  });

  async function run(
    route: 'codex' | 'claude' | 'opencode' | 'command',
    scripts: NonNullable<ConstructorParameters<typeof StubModelExecutor>[0]>['scripts'],
    modelsCfg: ModelsConfig = stdModels,
  ) {
    const worktree = await tmp.make('build-agents-1600-');
    await writeFile(join(worktree, 'AGENTS.md'), `# Rules\n\n## Standards\n\n- ${MARK}\n`);
    const specPath = join(worktree, 'issue-1600.md');
    await writeFile(specPath, '# spec\n');
    const stub = new StubModelExecutor({ scripts });
    const router = new ModelRouter(modelsCfg, routesAll, false, stub);
    const constitution = new ConstitutionLoader().loadFromRepo(worktree);
    const result = await buildPhase({
      issue: workKeyFromIssue(1600),
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'factory/1600-x',
      route,
      router,
      constitution,
      log: () => {},
    });
    return { stub, result };
  }
  const promptOf = (stub: StubModelExecutor, task: string) => stub.calls.find((c) => c.task === task)!.prompt;

  it('codex BUILD prompt omits the auto-loaded AGENTS.md marker line (#1600)', async () => {
    const { stub } = await run('codex', { build_codex: [{ output: 'ok' }] });
    const p = promptOf(stub, 'build_codex');
    expect(p).not.toContain(MARK);
    expect(p).toContain('<standards source="AGENTS.md">');
    expect(p).toContain('loaded automatically by your agent harness');
  });

  it('claude BUILD prompt keeps the AGENTS.md marker line (#1600)', async () => {
    const { stub } = await run('claude', { build_claude: [{ output: 'ok' }] });
    expect(promptOf(stub, 'build_claude')).toContain(MARK);
  });

  it('opencode BUILD prompt omits AGENTS.md', async () => {
    const { stub } = await run('opencode', { build_opencode: [{ output: 'ok' }] });
    expect(promptOf(stub, 'build_opencode')).not.toContain(MARK);
  });

  it('command BUILD prompt keeps AGENTS.md', async () => {
    const { stub } = await run('command', { build_command: [{ output: 'ok' }] });
    expect(promptOf(stub, 'build_command')).toContain(MARK);
  });

  it('a mixed build_codex tier (codex-cli + codex-flagged ollama) keeps AGENTS.md', async () => {
    const mixed = cfg({
      'cx-a': mk('codex-cli', { codex: true, capabilities: ['codex'] }),
      'ol-a': mk('ollama-agentic', { codex: true, capabilities: ['codex'] }),
    });
    const { stub } = await run('codex', { build_codex: [{ output: 'ok' }] }, mixed);
    expect(promptOf(stub, 'build_codex')).toContain(MARK);
  });

  it('codex→claude failover prompt restores AGENTS.md while the codex prompt omitted it', async () => {
    const { stub } = await run('codex', {
      build_codex: [{ fail: 'usage_cap' }, { fail: 'usage_cap' }],
      build_claude: [{ output: 'ok' }],
    });
    expect(promptOf(stub, 'build_codex')).not.toContain(MARK);
    expect(promptOf(stub, 'build_claude')).toContain(MARK);
  });
});
