// src/run/attribution.ts — plan/build model attribution stamped on a run's terminal events (#3321).

import type {
  EventKind,
  FlakyTestsPayload,
  ParkPayload,
  StewardTriggeredPayload,
} from '../events/kinds.js';
import type { ProviderEventExtra } from '../events/payloads.js';
import type { PrClassificationRecord } from '../review/classifier.js';
import type {
  CheckFailureInfo,
  CiFailureEvidence,
  EscalateKind,
  FailoverReason,
  FailurePhase,
  ReadinessInfo,
} from '../types/index.js';
import type { ParkReason, RunAttribution, RunOutcome } from './outcome.js';
import type { RunPorts } from './run-issue.js';

export type RunLogFn = (
  type: EventKind,
  msg: string,
  extra?: ProviderEventExtra & {
    failoverReason?: FailoverReason;
    model?: string;
    tokens?: { input: number; output: number };
    readiness?: ReadinessInfo;
    prClassification?: PrClassificationRecord;
    checkFailure?: CheckFailureInfo;
    ciFailure?: CiFailureEvidence;
    escalateKind?: EscalateKind;
    stewardTriggered?: StewardTriggeredPayload;
    flakyTests?: FlakyTestsPayload;
    park?: ParkPayload;
    attribution?: RunAttribution;
  },
) => void;

const STAMPED: Record<ParkReason, true> = {
  escalate: true,
  timeout: true,
  fail: true,
  conflict: true,
  'ci-failed': true,
  'ci-infra': true,
  held: true,
  config: true,
  blocked: true,
};

type Slot = NonNullable<RunAttribution['plan']>;

export function withRunAttribution(ports: RunPorts): { ports: RunPorts; stamp: (outcome: RunOutcome) => RunOutcome } {
  let plan: Slot | undefined;
  let build: Slot | undefined;
  let endedIn: FailurePhase = 'plan';

  const snapshot = (): RunAttribution => ({
    ...(plan && { plan: { ...plan } }),
    ...(build && { build: { ...build } }),
    endedIn,
  });

  const record = (task: string, model: string): void => {
    const isPlan = task === 'plan';
    if (!isPlan && !task.startsWith('build_')) return;
    const registry = ports.router.registryRef;
    const effort = registry.getEffort(model, task);
    const entry: Slot = {
      model,
      provider: registry.get(model)?.provider ?? 'unknown',
      ...(effort !== undefined && { effort }),
    };
    if (isPlan) plan = entry;
    else build = entry;
  };

  const router = new Proxy(ports.router, {
    get(target, prop) {
      if (prop === 'run') {
        return async (...args: Parameters<typeof target.run>) => {
          const result = await target.run(...args);
          record(args[0], result.model);
          return result;
        };
      }
      const value: unknown = target[prop as keyof typeof target];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const recordPhase = (phase: FailurePhase): void | Promise<void> => {
    endedIn = phase;
    return ports.recordPhase?.(phase);
  };

  const events = (phase?: string): RunLogFn => {
    const log = ports.events(phase);
    return (type, msg, ...rest) =>
      Object.hasOwn(STAMPED, type) ? log(type, msg, { ...rest[0], attribution: snapshot() }) : log(type, msg, ...rest);
  };

  return {
    ports: { ...ports, router, recordPhase, events },
    stamp: (outcome) => ({ ...outcome, attribution: snapshot() }),
  };
}
