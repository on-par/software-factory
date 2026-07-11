import matter from 'gray-matter';
import type { DeterministicCheck, ExpectedRoute } from './types.js';

type ScoredRoute = 'codex' | 'claude' | 'escalate' | 'unparseable';

export function scoreSpec(
  specContent: string,
  output: string,
  expected: ExpectedRoute,
): { route: ScoredRoute; routeCorrect: boolean; checks: DeterministicCheck[] } {
  if (output.split('\n').some(line => line.startsWith('ESCALATE:'))) {
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

  let frontmatterPass = false;
  try {
    frontmatterPass = Object.keys(matter(specContent).data).length > 0;
  } catch {
    frontmatterPass = false;
  }

  const routeMatch = specContent.match(/^route:\s*(codex|claude)\s*$/m);
  const route = (routeMatch?.[1] as 'codex' | 'claude' | undefined) ?? 'unparseable';
  const routeCorrect = expected === 'any' || route === expected;
  const missingSections = ['## Goal', '## Files / approach', '## Tests', '## Non-goals']
    .filter(section => !specContent.includes(section));

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
