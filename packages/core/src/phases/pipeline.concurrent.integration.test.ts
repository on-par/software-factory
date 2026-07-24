import { exec as execCb } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import {
  commitAll,
  makeFakeOctokit,
  makeStubModelsConfig,
  makeStubRoutesConfig,
  PipelineTestKit,
  specContentFor,
} from '../test-support/index.js';
import { branchFor, gitFetch, setupWorktree } from '../utils/index.js';
import { withGitLock } from '../utils/lock.js';
import { buildPhase } from './build.js';
import { checkPhase } from './check.js';
import { planPhase } from './plan.js';
import { shipPhase } from './ship.js';

const exec = promisify(execCb);
const repo = 'on-par/software-factory';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const kit = new PipelineTestKit();

afterEach(() => kit.cleanup());

describe('concurrent lanes integration', () => {
  it(
    'two lanes run concurrently: each gets its own PR and the lock serializes the worktree critical section',
    { timeout: 180_000 },
    async () => {
      const { origin, repoRoot } = await kit.makeThrowawayRepo();
      const titles: Record<number, string> = { 41: 'Concurrent lane one', 42: 'Concurrent lane two' };
      const { octokit, calls } = makeFakeOctokit(titles);
      const intervals: Array<{ issue: number; enter: number; exit: number }> = [];

      async function runLane(issue: number) {
        const events: Array<[string, string]> = [];
        const log = (type: string, msg: string) => events.push([type, msg]);
        const stub = new StubModelExecutor({
          scripts: {
            plan: [{ output: specContentFor(issue, 'Concurrent lane test') }],
            build_claude: [
              {
                output: 'built',
                effect: async (ctx) => {
                  await writeFile(join(ctx.worktree, `feature-${issue}.txt`), `lane ${issue}\n`);
                  await commitAll(ctx.worktree, `feat: lane ${issue}`);
                },
              },
            ],
          },
        });
        const router = new ModelRouter(makeStubModelsConfig(), makeStubRoutesConfig(), false, stub);
        const constitution = null;

        const branch = branchFor(issue, titles[issue]);
        const worktree = kit.trackWorktree(repoRoot, issue);
        const specPath = await kit.makeSpecPath(issue);

        const plan = await planPhase({
          issue,
          repo,
          worktree,
          specPath,
          router,
          constitution,
          octokit: octokit as any,
          log,
        });
        expect(plan.ok).toBe(true);

        await withGitLock(repoRoot, async () => {
          const enter = performance.now();
          await delay(25);
          await gitFetch(repoRoot);
          await setupWorktree(repoRoot, branch, worktree);
          intervals.push({ issue, enter, exit: performance.now() });
        });

        const build = await buildPhase({
          issue,
          repo,
          worktree,
          specPath,
          branch,
          route: plan.route,
          router,
          constitution,
          log,
        });
        expect(build.ok).toBe(true);

        const check = await checkPhase({ issue, worktree, specPath, router, constitution, log });
        expect(check.passed).toBe(true);

        const ship = await shipPhase({
          issue,
          repo,
          worktree,
          branch,
          octokit: octokit as any,
          watchCI: false,
          log,
        });

        return { issue, branch, ship };
      }

      const results = await Promise.all([runLane(41), runLane(42)]);

      for (const result of results) {
        expect(result.ship.ok).toBe(true);
      }
      const prNumbers = results.map((r) => r.ship.prNumber);
      expect(prNumbers[0]).toBeDefined();
      expect(prNumbers[1]).toBeDefined();
      expect(prNumbers[0]).not.toBe(prNumbers[1]);

      const createCalls = calls.filter(([name]) => name === 'pulls.create');
      expect(createCalls).toHaveLength(2);
      for (const result of results) {
        expect(createCalls).toContainEqual([
          'pulls.create',
          expect.objectContaining({
            head: result.branch,
            body: expect.stringContaining(`Closes #${result.issue}`),
          }),
        ]);
        await expect(exec(`git -C '${origin}' rev-parse --verify refs/heads/'${result.branch}'`)).resolves.toBeTruthy();
      }

      expect(intervals).toHaveLength(2);
      const sorted = [...intervals].sort((a, b) => a.enter - b.enter);
      expect(sorted[0].exit).toBeLessThanOrEqual(sorted[1].enter);
    },
  );

  it(
    'two lanes with leased ports run checkPhase concurrently without colliding on a shared port',
    { timeout: 180_000 },
    async () => {
      const { repoRoot } = await kit.makeThrowawayRepo();
      const lanes: Array<{ issue: number; appPort: number }> = [
        { issue: 43, appPort: 4361 },
        { issue: 44, appPort: 4362 },
      ];

      async function runLane(issue: number, appPort: number) {
        const events: Array<[string, string]> = [];
        const log = (type: string, msg: string) => events.push([type, msg]);
        const stub = new StubModelExecutor({
          scripts: {
            build_claude: [
              {
                output: 'built',
                effect: async (ctx) => {
                  await writeFile(join(ctx.worktree, 'check-port.mjs'), CHECK_PORT_SCRIPT);
                  await writeFile(
                    join(ctx.worktree, 'package.json'),
                    JSON.stringify({ scripts: { test: 'node check-port.mjs' } }),
                  );
                  await commitAll(ctx.worktree, `feat: env-asserting lane ${issue}`);
                },
              },
            ],
          },
        });
        const router = new ModelRouter(makeStubModelsConfig(), makeStubRoutesConfig(), false, stub);
        const constitution = null;

        const branch = branchFor(issue, `Env lane ${issue}`);
        const worktree = kit.trackWorktree(repoRoot, issue);
        const specPath = await kit.makeSpecPath(issue);

        await withGitLock(repoRoot, async () => {
          await gitFetch(repoRoot);
          await setupWorktree(repoRoot, branch, worktree);
        });

        const build = await buildPhase({
          issue,
          repo,
          worktree,
          specPath,
          branch,
          route: 'claude',
          router,
          constitution,
          log,
          appPort,
        });
        expect(build.ok).toBe(true);

        const check = await checkPhase({ issue, worktree, specPath, router, constitution, log, appPort });
        expect(check.passed).toBe(true);

        const boundPort = (await readFile(join(worktree, 'bound-port.txt'), 'utf-8')).trim();
        return { issue, appPort, boundPort };
      }

      const results = await Promise.all(lanes.map((l) => runLane(l.issue, l.appPort)));

      for (const result of results) {
        expect(result.boundPort).toBe(String(result.appPort));
      }
    },
  );
});

const CHECK_PORT_SCRIPT = `import http from 'node:http';
import { writeFile } from 'node:fs/promises';

const server = http.createServer((_req, res) => {
  res.writeHead(200);
  res.end('ok');
});

server.on('error', (err) => {
  console.error('server error', err);
  process.exit(1);
});

server.listen(Number(process.env.PORT), '127.0.0.1', async () => {
  try {
    const boundPort = server.address().port;
    if (boundPort !== Number(process.env.FACTORY_APP_PORT)) {
      throw new Error(\`port mismatch: bound \${boundPort} expected \${process.env.FACTORY_APP_PORT}\`);
    }

    const response = await fetch(process.env.FACTORY_BASE_URL);
    if (response.status !== 200) {
      throw new Error(\`unexpected status \${response.status}\`);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    await writeFile('bound-port.txt', String(boundPort));
    server.close(() => process.exit(0));
  } catch (err) {
    console.error(err);
    server.close(() => process.exit(1));
  }
});
`;
