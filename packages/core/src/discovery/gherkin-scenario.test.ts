import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Naming the deprecated alias in a type position trips typescript/no-deprecated (never suppressed),
// so guard the public re-export and the alias definition by their source text instead.
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

it('keeps GherkinScenario re-exported from the core root as an alias of AcceptanceCriterion', () => {
  expect(read('../index.ts')).toContain("export type * from './discovery/gherkin-scenario.js';");
  expect(read('./gherkin-scenario.ts')).toMatch(/export type GherkinScenario = AcceptanceCriterion;/);
});
