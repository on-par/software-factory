// src/events/command-output-traits.ts — EventKind members and EVENT_TRAITS entries for opt-in OTLP export of command
// output; spread into the table in kinds.ts (split out to keep kinds.ts under its max-lines ceiling).

import type { EventTraits } from './event-traits.js';

export type CommandOutputEventKind = 'command_output_export' | 'command_output_export_degraded';

export const COMMAND_OUTPUT_EVENT_TRAITS: Record<CommandOutputEventKind, EventTraits> = {
  // Per-CHECK summary of opt-in OTLP export of command output: sent/dropped/failed (#3995).
  command_output_export: { severity: 'info', isPark: false, isTerminal: false },
  // Export lost records or was requested with invalid OTEL_* config; the run is unaffected (#3995).
  command_output_export_degraded: { severity: 'warn', isPark: false, isTerminal: false },
};
