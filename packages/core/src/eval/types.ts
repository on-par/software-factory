import type { JudgeSample } from './judge.js';

export type ExpectedRoute = 'codex' | 'claude' | 'escalate' | 'any';

// A case is "route-asserted" when it expects a specific route, i.e. it can be misrouted.
export function isRouteAsserted(expectedRoute: ExpectedRoute): boolean {
  return expectedRoute !== 'any';
}

export interface GoldenCase {
  id: string;
  title: string;
  body: string;
  expectedRoute: ExpectedRoute;
  deterministicOnly: boolean;
  rubric: string[];
  minRubricScore: number;
  stubOutput?: string;
  constitution?: string;
  path: string;
}

export interface DeterministicCheck {
  name: string;
  pass: boolean;
  details: string;
}

export interface CaseResult {
  id: string;
  pass: boolean;
  route: 'codex' | 'claude' | 'escalate' | 'unparseable';
  expectedRoute: ExpectedRoute;
  routeCorrect: boolean;
  checks: DeterministicCheck[];
  rubricScore?: number;
  judgeMalformed?: boolean;
  judgeSamples?: JudgeSample[];
  judgeValidCount?: number;
  judgeMalformedCount?: number;
  judgeSkipped: boolean;
  model: string;
  latencyMs: number;
  costEstimate: number;
  error?: string;
}

export interface EvalSummary {
  results: CaseResult[];
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  routeAsserted: number;
  // With no asserted routes, there is nothing that can misroute, so the gate should pass.
  routeAccuracy: number;
  totalCostEstimate: number;
  totalLatencyMs: number;
}
