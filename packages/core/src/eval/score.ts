import matter from 'gray-matter';
import { isEscalation } from '../utils/index.js';
import type { DeterministicCheck, ExpectedRoute } from './types.js';

type ScoredRoute = 'codex' | 'claude' | 'escalate' | 'unparseable';

export function scoreSpec(
  specContent: string,
  output: string,
  expected: ExpectedRoute,
  opts: { requireConstitution?: boolean } = {},
): { route: ScoredRoute; routeCorrect: boolean; checks: DeterministicCheck[] } {
  if (isEscalation(output)) {
    const routeCorrect = expected === 'escalate' || expected === 'any';
    return {
      route: 'escalate',
      routeCorrect,
      checks: [
        { name: 'frontmatter-valid', pass: true, details: 'n/a — escalated' },
        { name: 'route-parseable', pass: true, details: 'n/a — escalated' },
        { name: 'sections-present', pass: true, details: 'n/a — escalated' },
        { name: 'route-correct', pass: routeCorrect, details: routeCorrect ? 'expected escalation' : `expected ${expected}` },
      ],
    };
  }

  let data: Record<string, unknown> = {};
  let frontmatterPass = false;
  try {
    data = matter(specContent).data;
    frontmatterPass = Object.keys(data).length > 0;
  } catch {
    frontmatterPass = false;
  }

  const rawRoute = typeof data.route === 'string' ? data.route.trim() : undefined;
  const route: ScoredRoute = rawRoute === 'codex' || rawRoute === 'claude' ? rawRoute : 'unparseable';
  const routeCorrect = expected === 'any' || route === expected;
  const requiredSections = ['## Goal', '## Files / approach', '## Tests', '## Non-goals'];
  if (opts.requireConstitution) requiredSections.push('## Constitution compliance');
  const missingSections = requiredSections.filter(section => !specContent.includes(section));

  return {
    route,
    routeCorrect,
    checks: [
      {
        name: 'frontmatter-valid',
        pass: frontmatterPass,
        details: frontmatterPass ? 'frontmatter parsed' : 'missing or invalid frontmatter',
      },
      {
        name: 'route-parseable',
        pass: route !== 'unparseable',
        details: route !== 'unparseable' ? `route ${route}` : 'missing route: codex|claude',
      },
      {
        name: 'sections-present',
        pass: missingSections.length === 0,
        details: missingSections.length === 0 ? 'all required sections present' : `missing ${missingSections.join(', ')}`,
      },
      {
        name: 'route-correct',
        pass: routeCorrect,
        details: expected === 'any' ? 'any route accepted' : `expected ${expected}, got ${route}`,
      },
    ],
  };
}
