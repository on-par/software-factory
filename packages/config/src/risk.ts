// packages/config/src/risk.ts — Risk rule schema, defaults and validator (#3380)
//
// A risk tier (low | med | high) is derived from changed file paths. This module
// is data only: the types, the packaged defaults and a hand-written validator
// (packages/config stays zero-dependency). The evaluator lives in core.

export type RiskTier = 'low' | 'med' | 'high';

/** Ordered low → high; the index is the precedence. */
export const RISK_TIERS: readonly RiskTier[] = ['low', 'med', 'high'];

export interface RiskRule {
  /** /^[a-z0-9][a-z0-9-]*$/, unique in the set. */
  id: string;
  tier: RiskTier;
  description?: string;
  /** Globs over the whole repo-relative path; '**' crosses '/', '*' and '?' do not; case-insensitive. */
  globs?: readonly string[];
  /** Regex sources tested against the whole path with the 'i' flag. */
  patterns?: readonly string[];
  /** Code-defined only. Never parsed from a file. */
  predicate?: (path: string) => boolean;
}

export interface RiskRuleSet {
  rules: readonly RiskRule[];
  /** Globs for allowlisted pure-refactor paths; matching paths fire the low 'allowlisted-refactor' rule. */
  refactorAllowlist?: readonly string[];
}

export class RiskRulesError extends Error {
  readonly ruleId: string | undefined;
  readonly index: number | undefined;

  constructor(message: string, ruleId?: string, index?: number) {
    super(message);
    this.name = 'RiskRulesError';
    this.ruleId = ruleId;
    this.index = index;
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const RULE_KEYS = new Set(['id', 'tier', 'description', 'globs', 'patterns', 'predicate']);
const TOP_KEYS = new Set(['rules', 'refactorAllowlist']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function topError(reason: string): RiskRulesError {
  return new RiskRulesError(`invalid risk rules: ${reason}`);
}

function ruleError(index: number, id: string | undefined, reason: string): RiskRulesError {
  const where = id === undefined ? `at rules[${index}]` : `"${id}" (rules[${index}])`;
  return new RiskRulesError(`invalid risk rule ${where}: ${reason}`, id, index);
}

function stringList(value: unknown, label: string, fail: (reason: string) => RiskRulesError): string[] {
  if (!Array.isArray(value)) throw fail(`${label} must be an array of non-empty strings`);
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') throw fail(`${label} must contain only non-empty strings`);
  }
  return [...(value as string[])];
}

function parseRule(raw: unknown, index: number, seen: Set<string>): RiskRule {
  if (!isPlainObject(raw)) throw ruleError(index, undefined, 'rule must be an object');
  const id = typeof raw.id === 'string' ? raw.id : undefined;
  const fail = (reason: string): RiskRulesError => ruleError(index, id, reason);

  for (const key of Object.keys(raw)) {
    if (!RULE_KEYS.has(key)) throw fail(`unknown key "${key}"`);
  }
  if (id === undefined || !ID_PATTERN.test(id)) {
    throw fail('id must be a non-empty string matching /^[a-z0-9][a-z0-9-]*$/');
  }
  if (seen.has(id)) throw fail(`duplicate id "${id}"`);
  seen.add(id);

  const tier = RISK_TIERS.find((t) => t === raw.tier);
  if (tier === undefined) throw fail(`tier must be one of ${RISK_TIERS.join(', ')}`);

  const rule: RiskRule = { id, tier };
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string') throw fail('description must be a string');
    rule.description = raw.description;
  }
  if (raw.globs !== undefined) rule.globs = stringList(raw.globs, 'globs', fail);
  if (raw.patterns !== undefined) {
    const patterns = stringList(raw.patterns, 'patterns', fail);
    for (const src of patterns) {
      try {
        new RegExp(src, 'i');
      } catch (err) {
        throw fail(`pattern "${src}" does not compile: ${(err as Error).message}`);
      }
    }
    rule.patterns = patterns;
  }
  if (raw.predicate !== undefined) {
    if (typeof raw.predicate === 'string') {
      throw fail('predicate must be a function; string predicates from config are not evaluated');
    }
    if (typeof raw.predicate !== 'function') throw fail('predicate must be a function');
    rule.predicate = raw.predicate as (path: string) => boolean;
  }
  if (!rule.globs?.length && !rule.patterns?.length && rule.predicate === undefined) {
    throw fail('rule needs at least one matcher: globs, patterns or predicate');
  }
  return rule;
}

/** Validate an already-parsed (YAML/JSON) risk rule object. Throws RiskRulesError naming the bad rule. */
export function parseRiskRules(raw: unknown): RiskRuleSet {
  if (!isPlainObject(raw)) throw topError('expected an object with a "rules" array');
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) throw topError(`unknown key "${key}"`);
  }
  if (!Array.isArray(raw.rules)) throw topError('"rules" must be an array');

  const seen = new Set<string>();
  const rules = raw.rules.map((r: unknown, i: number) => parseRule(r, i, seen));
  const result: RiskRuleSet = { rules };
  if (raw.refactorAllowlist !== undefined) {
    result.refactorAllowlist = stringList(raw.refactorAllowlist, 'refactorAllowlist', topError);
  }
  return result;
}

export const DEFAULT_RISK_RULES: RiskRuleSet = {
  rules: [
    {
      id: 'migrations-schema',
      tier: 'high',
      description: 'Database migrations and schema definitions',
      globs: ['**/migrations/**', '**/migrate/**', '**/*.sql', '**/schema.prisma'],
      patterns: ['(^|/)schema(\\.[a-z]+)?$'],
    },
    {
      id: 'auth',
      tier: 'high',
      description: 'Authentication and sessions',
      patterns: ['(^|[/._-])(auth\\w*|oauth|sso|login|session)([/._-]|$)'],
    },
    {
      id: 'secrets-env',
      tier: 'high',
      description: 'Secrets and environment files',
      globs: ['**/.env', '**/.env.*'],
      patterns: ['secret|credential|(^|[/._-])(tokens?|keys?)([/._-]|$)'],
    },
    {
      id: 'billing',
      tier: 'high',
      description: 'Billing and payments',
      patterns: ['billing|payment|invoice|stripe|subscription'],
    },
    {
      id: 'customer-data',
      tier: 'high',
      description: 'Customer and personal data',
      patterns: ['stomp|customer|(^|[/._-])pii([/._-]|$)|gdpr|user-?data'],
    },
    {
      id: 'permissions-acl',
      tier: 'high',
      description: 'Permissions and access control',
      patterns: ['permission|(^|[/._-])(acl|rbac|roles?)([/._-]|$)'],
    },
    {
      id: 'crypto',
      tier: 'high',
      description: 'Cryptography',
      patterns: ['crypto|encrypt|decrypt|cipher|(^|[/._-])(kms|hmac|signing)([/._-]|$)'],
    },
    {
      id: 'public-api',
      tier: 'med',
      description: 'Public API surface',
      globs: ['**/index.ts', '**/*.d.ts', '**/api/**', '**/openapi*'],
    },
    {
      id: 'workers-crons',
      tier: 'med',
      description: 'Background workers and scheduled jobs',
      patterns: ['(^|[/._-])(workers?|crons?|jobs?|scheduler)([/._-]|$)'],
    },
    {
      id: 'build-release',
      tier: 'med',
      description: 'Build and release tooling',
      globs: ['scripts/**', '.github/workflows/**', '**/Dockerfile', '**/Makefile'],
      patterns: ['(^|/)(build|release)[^/]*$'],
    },
    {
      id: 'docs',
      tier: 'low',
      description: 'Documentation',
      globs: ['docs/**', '**/*.md', '**/*.mdx'],
    },
    {
      id: 'tests-only',
      tier: 'low',
      description: 'Tests and fixtures',
      globs: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**', '**/__fixtures__/**', '**/test/**', '**/tests/**'],
    },
    {
      id: 'changelog',
      tier: 'low',
      description: 'Changelogs',
      globs: ['**/CHANGELOG*'],
    },
  ],
  refactorAllowlist: [],
};
