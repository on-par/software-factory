import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compareToBaseline,
  loadGoldenCases,
  loadModelsConfig,
  loadRoutesConfig,
  ModelRouter,
  runEval,
  StubModelExecutor,
  toBaseline,
} from '@on-par/factory-core';
import type { Baseline, ModelsConfig, RoutesConfig } from '@on-par/factory-core';

interface Args {
  stub: boolean;
  judge: boolean;
  filter?: string;
  dir: string;
  report?: string;
  baseline?: string;
  writeBaseline?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { stub: false, judge: true, dir: 'evals/golden' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--stub') args.stub = true;
    else if (arg === '--no-judge') args.judge = false;
    else if (arg === '--filter') args.filter = argv[++i];
    else if (arg === '--dir') args.dir = argv[++i] ?? args.dir;
    else if (arg === '--report') args.report = argv[++i];
    else if (arg === '--baseline') args.baseline = argv[++i];
    else if (arg === '--write-baseline') args.writeBaseline = argv[++i];
    else throw new Error(`unknown flag: ${arg}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const allCases = await loadGoldenCases(resolve(args.dir));
const cases = args.filter ? allCases.filter(c => c.id.includes(args.filter!)) : allCases;
const router = args.stub ? buildStubRouter(cases) : new ModelRouter(loadModelsConfig(), loadRoutesConfig());
const summary = await runEval({
  cases,
  router,
  judge: args.stub ? false : args.judge,
  worktree: process.cwd(),
});

printTable(summary.results, new Map(cases.map(c => [c.id, c.expectedRoute])));
const routeCorrectCount = summary.results.filter(result => result.expectedRoute !== 'any' && result.routeCorrect).length;
console.log(
  `pass-rate ${summary.passed}/${summary.total} (${Math.round(summary.passRate * 100)}%) · ` +
  `route-accuracy ${Math.round(summary.routeAccuracy * 100)}% (${routeCorrectCount}/${summary.routeAsserted}) · ` +
  `est. cost $${summary.totalCostEstimate.toFixed(4)} · ` +
  `total latency ${(summary.totalLatencyMs / 1000).toFixed(2)}s`,
);

if (args.report) {
  writeFileSync(args.report, JSON.stringify(summary, null, 2) + '\n');
}

if (args.writeBaseline) {
  writeFileSync(args.writeBaseline, JSON.stringify(toBaseline(summary), null, 2) + '\n');
}

if (args.baseline) {
  const baseline: Baseline = JSON.parse(readFileSync(args.baseline, 'utf8'));
  const comparison = compareToBaseline(summary, baseline);
  for (const note of comparison.notes) console.log(`NOTE: ${note}`);
  for (const regression of comparison.regressions) console.log(`REGRESSION: ${regression}`);
  process.exitCode = comparison.ok ? 0 : 1;
} else if (summary.failed > 0) {
  process.exitCode = 1;
}

function buildStubRouter(cases: typeof allCases): ModelRouter {
  const models: ModelsConfig = {
    version: 1,
    models: {
      'stub-model': {
        provider: 'custom',
        tier: ['boss', 'checker'],
        costPerMtokInput: 0,
        costPerMtokOutput: 0,
        contextWindow: 1000,
        capabilities: [],
        envKey: null,
      },
    },
    tiers: { boss: ['stub-model'], checker: ['stub-model'] },
    failover: {
      triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
      maxRetries: 0,
      cooldownMs: 0,
      escalateAfterTierExhausted: true,
    },
    routingRules: {},
  };
  const routes: RoutesConfig = {
    version: 1,
    routes: {
      plan: { tier: 'boss', description: 'stub plan' },
      eval_judge: { tier: 'checker', description: 'stub judge' },
    },
  };
  const executor = new StubModelExecutor({
    scripts: {
      plan: cases.map(c => ({ output: c.stubOutput ?? '' })),
    },
  });
  return new ModelRouter(models, routes, false, executor);
}

function printTable(results: typeof summary.results, expectedRoutes: Map<string, string>) {
  console.log([
    'id'.padEnd(28),
    'route'.padEnd(12),
    'expected'.padEnd(10),
    'checks'.padEnd(8),
    'rubric'.padEnd(8),
    'latency'.padEnd(10),
    'cost',
  ].join(' '));

  for (const result of results) {
    const checksPassed = `${result.checks.filter(c => c.pass).length}/${result.checks.length}`;
    const rubric = result.rubricScore === undefined ? '—' : result.rubricScore.toFixed(1);
    console.log([
      result.id.padEnd(28),
      result.route.padEnd(12),
      (expectedRoutes.get(result.id) ?? '?').padEnd(10),
      checksPassed.padEnd(8),
      rubric.padEnd(8),
      `${result.latencyMs}ms`.padEnd(10),
      `$${result.costEstimate.toFixed(4)}`,
    ].join(' '));
    if (result.error) console.log(`  error: ${result.error}`);
  }
}
