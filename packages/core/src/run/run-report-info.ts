// src/run/run-report-info.ts — what runIssue hands the local run report and benchmark artifact writers.

import type { CheckSummary, FailurePhase } from '../types/index.js';
import type { BuildRoute } from './outcome.js';

export interface RunReportInfo {
  outcome: 'ready' | 'failed' | 'parked' | 'escalated';
  route?: BuildRoute;
  branch?: string;
  reworkRounds?: number;
  checkSummary?: CheckSummary;
  reason?: string;
  failure?: { phase: FailurePhase; reason: string; message: string };
  reportPath?: string;
  diffBase?: string;
}
