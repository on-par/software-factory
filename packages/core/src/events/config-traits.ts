// src/events/config-traits.ts — EventKind members and EVENT_TRAITS entries for run-start config warnings; spread into
// the table in kinds.ts (split out to keep kinds.ts under its max-lines ceiling).

import type { EventTraits } from './event-traits.js';

export type ConfigEventKind = 'config_unknown_key' | 'config_invalid_value';

export const CONFIG_EVENT_TRAITS: Record<ConfigEventKind, EventTraits> = {
  // An unknown nested config key stripped by the runtime schema, warned once per key at run start (#3568).
  config_unknown_key: { severity: 'warn', isPark: false, isTerminal: false },
  // A known config key with an unsupported value, ignored with a warning at run start (#3829, ADR-0160).
  config_invalid_value: { severity: 'warn', isPark: false, isTerminal: false },
};
