import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import type { EventKind } from '../events/kinds.js';
import type { PlanResult } from './plan.js';
import type { BuildRoutePin } from '../config/repo.js';
import { invalidPlanReason, specHasImplementation } from './plan-spec-validity.js';

const SPEC_WRITE_DENIAL =
  /sandbox denied|operation not permitted|\bEACCES\b|\bEPERM\b|outside the writable|read-only file system/i;

/** True when a planner output reports that writing specPath was denied (#3269). Needs both the path and a denial phrase. */
export function specWriteDenied(output: string, specPath: string): boolean {
  if (!SPEC_WRITE_DENIAL.test(output)) return false;
  const names = [specPath, dirname(specPath), `plans/${basename(specPath)}`];
  return names.some((n) => n.length > 1 && output.includes(n));
}

export function blockedNoChangeSpecReason(body: string): string | null {
  const looksBlocked = /^\s*Blocked(?::|\s+by\b)/im.test(body);
  if (!looksBlocked) return null;

  const saysNoChanges = /\bno files? (?:were )?changed\b/i.test(body) || /\bno changes? (?:were )?made\b/i.test(body);
  const pointsAtSandbox =
    /\bsandbox\b/i.test(body) || /\boutside (?:the )?(?:worktree|workspace|checkout)\b/i.test(body);
  if (!saysNoChanges && !pointsAtSandbox) return null;

  return 'PLAN returned a blocked/no-change note instead of a frozen spec';
}

/** Why a spec with no valid design artifact can't go to BUILD: a blocked/no-change note, or no
 *  Files / approach section to build from (#3270). Null when BUILD can proceed without the design. */
export function noBuildReason(body: string, errors: readonly string[], attempts: number): string | null {
  return blockedNoChangeSpecReason(body) ?? (specHasImplementation(body) ? null : invalidPlanReason(errors, attempts));
}

/** Parks `config` when the planner's output reports a denied spec write and no spec file exists (#3269). */
export function specWriteDeniedResult(
  result: { output: string; model: string },
  specPath: string,
  route: BuildRoutePin,
  log: (type: EventKind, msg: string) => void,
): PlanResult | null {
  if (existsSync(specPath) || !specWriteDenied(result.output, specPath)) return null;
  const message = `PLAN could not write its spec to ${specPath}: the planner (model ${result.model}) reported the write was denied by its harness sandbox or file permissions`;
  log('config', message);
  return {
    ok: false,
    route,
    specPath,
    model: result.model,
    escalate: message,
    parkReason: 'config',
    designArtifact: null,
  };
}

export function planSummary(r: PlanResult): string {
  if (r.ok) return `plan complete (route ${r.route}, model ${r.model})`;
  return `${r.parkReason === 'config' ? 'plan parked (config)' : 'plan escalated'}: ${r.escalate ?? 'unknown'}`;
}

export function planConfigParkMessage(plan: PlanResult, issue: number): string {
  return `${plan.escalate}\nthen fix the harness writable roots and run factory unpark ${issue}`;
}
