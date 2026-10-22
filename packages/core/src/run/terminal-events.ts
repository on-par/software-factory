// packages/core/src/run/terminal-events.ts — runIssue owns a run's single terminal event (#3435).
import { eventTraitsFor, type EventKind } from '../events/kinds.js';
import type { RunPorts } from './run-issue.js';

const PHASE_KINDS = new Set<EventKind>(['plan', 'build', 'check', 'ship']);

/** Phase-scoped loggers (events(phase)) log terminal kinds as their phase kind; only runIssue's unscoped logger ends a run. */
export function withSingleTerminalEvent(ports: RunPorts): RunPorts {
  const events: RunPorts['events'] = (phase) => {
    const log = ports.events(phase);
    if (phase === undefined) return log;
    const demoted: EventKind = PHASE_KINDS.has(phase as EventKind) ? (phase as EventKind) : 'warn';
    return (type, msg, ...rest) =>
      eventTraitsFor(type).isTerminal ? log(demoted, `[${type}] ${msg}`, ...rest) : log(type, msg, ...rest);
  };
  return { ...ports, events };
}
