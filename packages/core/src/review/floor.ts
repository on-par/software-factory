// packages/core/src/review/floor.ts — pure deterministic review floor (class A/B/C) from a diff (#1721, repo overrides #1723).

export type ReviewClass = 'A' | 'B' | 'C';

/** One changed path with its line counts (e.g. from `git diff --numstat`). */
export interface ReviewFloorPathChange {
  path: string;
  added: number;
  removed: number;
}

/** A data-only path rule. A path matches when ANY populated matcher matches. All
 *  comparisons are case-insensitive. Kept serializable so a later issue can load rules from config. */
export interface ReviewFloorPathRule {
  id: string;
  class: 'A' | 'C';
  /** Path starts with one of these (e.g. '.github/workflows/'). */
  prefixes?: readonly string[];
  /** Path ends with one of these (e.g. '.md'). */
  suffixes?: readonly string[];
  /** Last path segment equals one of these (e.g. 'package-lock.json'). */
  basenames?: readonly string[];
  /** Regex source tested against the whole path with the 'i' flag. */
  pattern?: string;
  /** Globs matched against the whole path ('**' crosses '/', '*' and '?' do not). */
  globs?: readonly string[];
}

export interface ReviewFloorRuleSet {
  rules: readonly ReviewFloorPathRule[];
  /** Total added+removed lines above which the floor is at least B. */
  maxLines: number;
}

export interface ReviewFloorInput {
  changes: readonly ReviewFloorPathChange[];
  /** Defaults to DEFAULT_REVIEW_FLOOR_RULES. */
  rules?: ReviewFloorRuleSet;
}

export interface ReviewFloorFiredRule {
  id: string;
  class: ReviewClass;
  paths: string[];
}

export interface ReviewFloorResult {
  floor: ReviewClass;
  rules: ReviewFloorFiredRule[];
}

export const DEFAULT_REVIEW_FLOOR_RULES: ReviewFloorRuleSet = {
  maxLines: 500,
  rules: [
    { id: 'workflows', class: 'C', prefixes: ['.github/workflows/'] },
    { id: 'merge-land', class: 'C', pattern: '(^|[/._-])(merge|land)([/._-]|$)' },
    {
      id: 'classifier',
      class: 'C',
      prefixes: ['packages/core/src/review/floor.'],
      pattern: 'classifier|review-policy',
    },
    { id: 'sensitive-name', class: 'C', pattern: 'security|auth|credential|token|secret' },
    {
      id: 'dependencies',
      class: 'C',
      basenames: [
        'package.json',
        'package-lock.json',
        'npm-shrinkwrap.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'bun.lockb',
        'go.mod',
        'go.sum',
        'Cargo.toml',
        'Cargo.lock',
        'requirements.txt',
        'poetry.lock',
        'Pipfile',
        'Pipfile.lock',
        'pyproject.toml',
        'Gemfile',
        'Gemfile.lock',
      ],
    },
    { id: 'docs-only', class: 'A', prefixes: ['docs/'], suffixes: ['.md'] },
    { id: 'tests-only', class: 'A', suffixes: ['.test.ts'] },
  ],
};

const CLASS_ORDER: Record<ReviewClass, number> = { A: 0, B: 1, C: 2 };

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

interface CompiledRule {
  rule: ReviewFloorPathRule;
  regex: RegExp | null;
  globs: RegExp[];
}

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

function matchesRule(path: string, { rule, regex, globs }: CompiledRule): boolean {
  const lower = path.toLowerCase();
  if (globs.some((g) => g.test(path))) return true;
  if (rule.prefixes?.some((p) => lower.startsWith(p.toLowerCase()))) return true;
  if (rule.suffixes?.some((s) => lower.endsWith(s.toLowerCase()))) return true;
  if (rule.basenames) {
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    if (rule.basenames.some((b) => b.toLowerCase() === base)) return true;
  }
  return regex !== null && regex.test(path);
}

function isValidCount(n: unknown): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Minimum review class for a diff, from changed paths and line counts alone.
 * Fails closed: empty or malformed input is C; A only when every path is covered by an A rule.
 */
export function computeReviewFloor(input: ReviewFloorInput): ReviewFloorResult {
  const ruleSet = input.rules ?? DEFAULT_REVIEW_FLOOR_RULES;
  if (input.changes.length === 0) {
    return { floor: 'C', rules: [{ id: 'empty-diff', class: 'C', paths: [] }] };
  }

  const invalid: string[] = [];
  const valid: { path: string; lines: number }[] = [];
  for (const c of input.changes) {
    const path = typeof c.path === 'string' ? normalizePath(c.path) : '';
    if (path === '' || !isValidCount(c.added) || !isValidCount(c.removed)) {
      invalid.push(typeof c.path === 'string' ? c.path : '');
    } else {
      valid.push({ path, lines: c.added + c.removed });
    }
  }
  const validPaths = [...new Set(valid.map((v) => v.path))];

  const compiled: CompiledRule[] = ruleSet.rules.map((rule) => ({
    rule,
    regex: rule.pattern === undefined ? null : new RegExp(rule.pattern, 'i'),
    globs: (rule.globs ?? []).map(globToRegExp),
  }));
  const cRules = compiled.filter((c) => c.rule.class === 'C');
  const aRules = compiled.filter((c) => c.rule.class === 'A');

  const fired: ReviewFloorFiredRule[] = [];
  if (invalid.length > 0) fired.push({ id: 'invalid-input', class: 'C', paths: invalid });

  for (const c of cRules) {
    const paths = validPaths.filter((p) => matchesRule(p, c));
    if (paths.length > 0) fired.push({ id: c.rule.id, class: 'C', paths });
  }

  const uncovered = validPaths.filter((p) => !aRules.some((a) => matchesRule(p, a)));
  if (uncovered.length > 0) fired.push({ id: 'outside-a-scope', class: 'B', paths: uncovered });

  const total = valid.reduce((sum, v) => sum + v.lines, 0);
  if (total > ruleSet.maxLines) fired.push({ id: 'size', class: 'B', paths: validPaths });

  if (fired.length === 0) {
    const rules: ReviewFloorFiredRule[] = [];
    for (const a of aRules) {
      const paths = validPaths.filter((p) => matchesRule(p, a));
      if (paths.length > 0) rules.push({ id: a.rule.id, class: 'A', paths });
    }
    return { floor: 'A', rules };
  }

  const floor = fired.reduce<ReviewClass>((max, r) => (CLASS_ORDER[r.class] > CLASS_ORDER[max] ? r.class : max), 'A');
  return { floor, rules: fired };
}

/** A repo's classifier config section, structurally (floor.ts stays dependency-free). */
export interface ReviewFloorOverrides {
  alwaysHuman?: readonly string[];
  autoEligible?: readonly string[];
  maxDiffLines?: number;
}

function pathRule(id: string, cls: 'A' | 'C', entries: readonly string[]): ReviewFloorPathRule {
  const globs: string[] = [];
  const prefixes: string[] = [];
  for (const e of entries) {
    if (/[*?]/.test(e)) globs.push(e);
    else prefixes.push(normalizePath(e));
  }
  return { id, class: cls, prefixes, globs };
}

/**
 * Merge a repo's classifier section onto the packaged rules. Escalate-only (ADR-0121):
 * alwaysHuman ADDS a C rule and every packaged C rule is kept; autoEligible replaces the
 * packaged A rules; maxDiffLines replaces maxLines. Unset keys keep the packaged value.
 */
export function applyReviewFloorOverrides(
  overrides: ReviewFloorOverrides | undefined,
  base: ReviewFloorRuleSet = DEFAULT_REVIEW_FLOOR_RULES,
): ReviewFloorRuleSet {
  if (
    overrides === undefined ||
    (overrides.alwaysHuman === undefined &&
      overrides.autoEligible === undefined &&
      overrides.maxDiffLines === undefined)
  ) {
    return base;
  }
  const rules: ReviewFloorPathRule[] = base.rules.filter((r) => r.class === 'C');
  if (overrides.alwaysHuman && overrides.alwaysHuman.length > 0) {
    rules.push(pathRule('repo-always-human', 'C', overrides.alwaysHuman));
  }
  if (overrides.autoEligible === undefined) {
    rules.push(...base.rules.filter((r) => r.class === 'A'));
  } else if (overrides.autoEligible.length > 0) {
    rules.push(pathRule('repo-auto-eligible', 'A', overrides.autoEligible));
  }
  return { rules, maxLines: overrides.maxDiffLines ?? base.maxLines };
}
