// src/events/config-traits.ts — EventKind members and EVENT_TRAITS entries for run-start config and base warnings;
// spread into the table in kinds.ts (split out to keep kinds.ts under its max-lines ceiling).

import type { EventTraits } from './event-traits.js';

export type ConfigEventKind =
  | 'config_unknown_key'
  | 'config_invalid_value'
  | 'config_source'
  | 'red-main'
  | 'red-main-cleared'
  | 'base_repair_proceeding';

export const CONFIG_EVENT_TRAITS: Record<ConfigEventKind, EventTraits> = {
  'red-main': { severity: 'warn', isPark: false, isTerminal: false },
  'red-main-cleared': { severity: 'info', isPark: false, isTerminal: false },
  // An unknown nested config key stripped by the runtime schema, warned once per key at run start (#3568).
  config_unknown_key: { severity: 'warn', isPark: false, isTerminal: false },
  // A known config key with an unsupported value, ignored with a warning at run start (#3829, ADR-0160).
  config_invalid_value: { severity: 'warn', isPark: false, isTerminal: false },
  // Which config and constitution sources a run started from, with redacted changed keys (#3906).
  config_source: { severity: 'info', isPark: false, isTerminal: false },
  // A run-issue base-repair run (FACTORY_BASE_HEALTH_REPAIR=1) entered PLAN on a red base instead of releasing.
  base_repair_proceeding: { severity: 'warn', isPark: false, isTerminal: false },
};
