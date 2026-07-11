import { describe, expect, it } from 'vitest';
import { scoreSpec } from './score.js';

const goodSpec = `---
route: codex
---
# Spec
## Goal
Do it.
## Files / approach
Edit a file.
## Tests
npm test
## Non-goals
No extras.
`;

describe('scoreSpec', () => {
  it('passes a well-formed codex spec', () => {
    const result = scoreSpec(goodSpec, goodSpec, 'codex');

    expect(result.route).toBe('codex');
    expect(result.routeCorrect).toBe(true);
    expect(result.checks.every(check => check.pass)).toBe(true);
  });

  it('fails missing frontmatter', () => {
    const result = scoreSpec(goodSpec.replace('---\nroute: codex\n---\n', ''), goodSpec, 'codex');

    expect(result.checks.find(check => check.name === 'frontmatter-valid')?.pass).toBe(false);
  });

  it('parses a quoted codex route', () => {
    const spec = goodSpec.replace('route: codex', 'route: "codex"');
    const result = scoreSpec(spec, spec, 'codex');

    expect(result.route).toBe('codex');
    expect(result.checks.find(check => check.name === 'route-parseable')?.pass).toBe(true);
  });

  it('parses claude routes with or without quotes', () => {
    const unquoted = goodSpec.replace('route: codex', 'route: claude');
    const quoted = goodSpec.replace('route: codex', 'route: "claude"');

    const unquotedResult = scoreSpec(unquoted, unquoted, 'claude');
    const quotedResult = scoreSpec(quoted, quoted, 'claude');

    expect(unquotedResult.route).toBe('claude');
    expect(unquotedResult.checks.find(check => check.name === 'route-parseable')?.pass).toBe(true);
    expect(quotedResult.route).toBe('claude');
    expect(quotedResult.checks.find(check => check.name === 'route-parseable')?.pass).toBe(true);
  });

  it('fails an unparseable route', () => {
    const spec = goodSpec.replace('route: codex', 'route: gpt-5');
    const result = scoreSpec(spec, spec, 'codex');

    expect(result.route).toBe('unparseable');
    expect(result.checks.find(check => check.name === 'route-parseable')?.pass).toBe(false);
  });

  it('fails when a required section is missing', () => {
    const spec = goodSpec.replace('## Tests\nnpm test\n', '');
    const result = scoreSpec(spec, spec, 'codex');

    expect(result.checks.find(check => check.name === 'sections-present')?.pass).toBe(false);
  });

  it('requires constitution compliance only when requested', () => {
    const missing = scoreSpec(goodSpec, goodSpec, 'codex', { requireConstitution: true });
    const withConstitution = `${goodSpec}## Constitution compliance
S1 satisfied.
`;
    const present = scoreSpec(withConstitution, withConstitution, 'codex', { requireConstitution: true });

    expect(missing.checks.find(check => check.name === 'sections-present')?.pass).toBe(false);
    expect(missing.checks.find(check => check.name === 'sections-present')?.details).toContain('## Constitution compliance');
    expect(present.checks.find(check => check.name === 'sections-present')?.pass).toBe(true);
  });

  it('fails route-correct when the spec route differs from expected', () => {
    const spec = goodSpec.replace('route: codex', 'route: claude');
    const result = scoreSpec(spec, spec, 'codex');

    expect(result.route).toBe('claude');
    expect(result.routeCorrect).toBe(false);
    expect(result.checks.find(check => check.name === 'route-correct')?.pass).toBe(false);
  });

  it('accepts any expected route', () => {
    const spec = goodSpec.replace('route: codex', 'route: claude');
    const result = scoreSpec(spec, spec, 'any');

    expect(result.routeCorrect).toBe(true);
  });

  it('scores escalation as correct only for escalate or any', () => {
    const escalated = scoreSpec('', 'ESCALATE: which surface should improve?', 'escalate');
    const any = scoreSpec('', 'ESCALATE: which surface should improve?', 'any');
    const wrong = scoreSpec('', 'ESCALATE: which surface should improve?', 'codex');

    expect(escalated.route).toBe('escalate');
    expect(escalated.routeCorrect).toBe(true);
    expect(any.routeCorrect).toBe(true);
    expect(wrong.routeCorrect).toBe(false);
    expect(wrong.checks.find(check => check.name === 'frontmatter-valid')?.pass).toBe(true);
  });
});
