import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ConstitutionLoader, ModelRouter } from '@on-par/factory-core';
import {
  createSimOctokit,
  createSimWorkspace,
  createTempDirs,
  StubModelExecutor,
  type SimWorkspace,
} from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './index.js';
import { captureConsole } from './test-support/console-capture.js';

const ISSUE = 7;

const SPEC = `---
route: claude
design:
  restatedProblem: Add a feature file to the fixture repository.
  approach:
    chosen: Let the scripted stub executor write the file.
    rejected: []
  interfacesTouched:
    - feature.txt
  behaviorContract:
    - feature.txt exists.
  verificationPlan:
    - command: test -f feature.txt
      passWhen: the file exists
  riskBlastRadius: Fixture repository only.
  openQuestions: []
---
# Spec: Add a feature (#${ISSUE})
## Goal
Add feature.txt.
## Files / approach
feature.txt
## Tests
test -f feature.txt
## Constitution compliance
N/A
## Non-goals
None.
`;

const CHECKOUT_INPUTS = {
  '.factory/config.yaml': 'version: 2\nchecks:\n  test: "false"\n',
  '.factory/constitution.md': '# Checkout standards\n',
  '.factory/agent-memory/core.md': 'checkout memory\n',
  '.factory/tests/test_checkout.py': 'def test_checkout(): assert False\n',
};

const tmp = createTempDirs();
let ws: SimWorkspace;
let lines: string[];
let restoreLog: () => void;

beforeEach(async () => {
  ws = await createSimWorkspace();
  vi.stubEnv('GH_TOKEN', 'test-token');
  const captured = captureConsole('log');
  lines = captured.lines;
  restoreLog = () => captured.spy.mockRestore();
});

afterEach(async () => {
  restoreLog();
  vi.unstubAllEnvs();
  delete process.env.FACTORY_PROJECT_CONFIG_DIR;
  delete process.env.FACTORY_PROJECT_CONFIG_DIR_SOURCE;
  process.exitCode = undefined;
  await ws.dispose();
  await tmp.cleanup();
});

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: ws.repoRoot, encoding: 'utf8' });
}

function projectDir(): string {
  const dir = tmp.makeSync('e2e-project-config-');
  mkdirSync(join(dir, 'tests'));
  const check = join(dir, 'tests', 'check.sh');
  writeFileSync(join(dir, 'config.yaml'), `version: 2\nsandbox:\n  runtime: none\nchecks:\n  test: sh ${check}\n`);
  writeFileSync(join(dir, 'constitution.md'), '# External standards\n');
  writeFileSync(check, 'grep -q feature feature.txt\n');
  return dir;
}

function commitCheckoutInputs(): void {
  for (const [rel, text] of Object.entries(CHECKOUT_INPUTS)) {
    mkdirSync(dirname(join(ws.repoRoot, rel)), { recursive: true });
    writeFileSync(join(ws.repoRoot, rel), text);
  }
  git('add', '-A');
  git('commit', '-qm', 'chore: checkout factory inputs');
  git('push', '-q', 'origin', 'main');
}

function stubRouter(stub: StubModelExecutor): typeof ModelRouter {
  return class extends ModelRouter {
    constructor(...args: ConstructorParameters<typeof ModelRouter>) {
      const [models, routes, dryRun, , ...rest] = args;
      super(models, routes, dryRun, stub, ...rest);
    }
  } as typeof ModelRouter;
}

function stubExecutor(): StubModelExecutor {
  return new StubModelExecutor({
    scripts: {
      plan: [{ output: SPEC }],
      build_claude: [
        {
          output: 'built',
          effect: (ctx) => {
            writeFileSync(join(ctx.worktree, 'feature.txt'), 'feature\n');
            execFileSync('git', ['add', 'feature.txt'], { cwd: ctx.worktree });
            execFileSync('git', ['commit', '-qm', 'feat: add feature'], { cwd: ctx.worktree });
          },
        },
      ],
      check_design: [{ output: JSON.stringify({ checker: 'design_smells', result: 'PASS', smells: [] }) }],
    },
  });
}

interface RunResult {
  exitCode: number | undefined;
  out: string;
  prompts: string;
  configSource: { msg: string; projectConfig?: unknown } | undefined;
}

function configSourceEvent(): RunResult['configSource'] {
  const file = join(ws.repoRoot, '.factory', 'state', 'events.ndjson');
  const events = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  return events
    .map((line) => JSON.parse(line) as { type: string; msg: string; projectConfig?: unknown })
    .find((event) => event.type === 'config_source');
}

async function runIssue(globalArgs: string[]): Promise<RunResult> {
  const stub = stubExecutor();
  const { octokit } = createSimOctokit({ titles: { [ISSUE]: 'Add a feature' } });
  await main(['node', 'factory', ...globalArgs, 'run-issue', String(ISSUE), '--in-place', '--no-pr'], {
    exec: async (cmd: string) => ({
      stdout: cmd.includes('rev-parse') ? ws.repoRoot : cmd.includes('gh repo view') ? 'o/r' : '',
      stderr: '',
    }),
    octokit: () => octokit as never,
    ModelRouter: stubRouter(stub),
    ConstitutionLoader,
    isCommandAvailable: () => true,
  });
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = undefined;
  const prompts = stub.calls
    .filter((call) => call.task === 'plan' || call.task === 'build_claude')
    .map((call) => call.prompt)
    .join('\n');
  return { exitCode, out: lines.join('\n'), prompts, configSource: configSourceEvent() };
}

function factoryStatus(): string[] {
  return git('status', '--porcelain', '--untracked-files=all')
    .split('\n')
    .filter((line) => line.includes('.factory/'));
}

describe('factory run-issue with only an external project config directory (#4341)', () => {
  it.each([
    { name: 'completes with flag', flag: true, source: '--project-config' },
    { name: 'completes with env var', flag: false, source: 'FACTORY_PROJECT_CONFIG_DIR' },
  ])('$name', async ({ flag, source }) => {
    const dir = projectDir();
    if (!flag) vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR', dir);
    expect(existsSync(join(ws.repoRoot, '.factory'))).toBe(false);

    const result = await runIssue(flag ? ['--project-config', dir] : []);

    expect(result.exitCode).toBeUndefined();
    expect(result.out).toContain(`Issue #${ISSUE} → checks passed`);
    expect(result.out).toContain(`config: ${source} (${join(dir, 'config.yaml')}); constitution: ${source}`);
    expect(result.prompts).toContain('External standards');
    expect(git('log', '-1', '--format=%s')).toBe('feat: add feature\n');
  });

  it('no new tracked files under .factory', async () => {
    const dir = projectDir();

    const result = await runIssue(['--project-config', dir]);

    expect(result.exitCode).toBeUndefined();
    expect(existsSync(join(ws.repoRoot, '.factory', 'state', 'events.ndjson'))).toBe(true);
    expect(factoryStatus()).toEqual([]);
    expect(git('ls-files', '.factory')).toBe('');
  });

  it('ignores checkout inputs and reports them', async () => {
    commitCheckoutInputs();
    const dir = projectDir();

    const result = await runIssue(['--project-config', dir]);

    const ignored = ['.factory/agent-memory', '.factory/config.yaml', '.factory/constitution.md', '.factory/tests'];
    expect(result.exitCode).toBeUndefined();
    expect(result.out).toContain(`Issue #${ISSUE} → checks passed`);
    expect(result.out).toContain(
      `external source: --project-config (${dir}); ignored checkout inputs: ${ignored.join(', ')}`,
    );
    expect(result.configSource?.projectConfig).toEqual({ source: '--project-config', dir, ignoredInputs: ignored });
    expect(result.prompts).toContain('External standards');
    expect(result.prompts).not.toContain('Checkout standards');
    expect(factoryStatus()).toEqual([]);
  });
});
