// packages/config/src/index.ts — Config package: resolve paths to shared config files
//
// Other packages import `resolveConfigPath` to find the constitution markdown
// files shipped by this package, and the default config objects from
// ./defaults.ts.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a config file shipped by this package. The constitution markdown lives
 * in src/ and the build copies it next to the compiled code (dist/constitutions,
 * see the `copy-assets` script), so the file sits beside this module both in dev
 * (src/index.ts under tsx/vitest) and after build (dist/index.js). The published
 * tarball carries dist/ only (#2336).
 */
export function resolveConfigPath(filename: string): string {
  return resolve(__dirname, filename);
}

/** Directory containing constitution markdown files */
export const constitutionsDir = resolveConfigPath('constitutions');

export {
  defaultEvidenceCaps,
  defaultFactoryConfig,
  defaultLaneBreakerThreshold,
  defaultModelsConfig,
  defaultRoutesConfig,
  type EvidenceCapsDefaults,
  type FactoryDefaults,
  type ModelDefaults,
  type ModelsDefaults,
  type RetiredModelDefaults,
  retiredModels,
  type RouteDefaults,
  type RoutesDefaults,
} from './defaults.js';

export {
  DEFAULT_RISK_RULES,
  parseRiskRules,
  RISK_TIERS,
  type RiskRule,
  RiskRulesError,
  type RiskRuleSet,
  type RiskTier,
} from './risk.js';

export { ANY_CONFIG_KEY, findUnknownConfigKeys, type KnownConfigKeys } from './unknown-keys.js';
