import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { repoRoutingConfigIssues, RepoFactoryConfigV2Schema } from './repo.js';

const rules = [
  { id: 'a', tier: 'high', globs: ['a/**'] },
  { id: 'b', tier: 'low', patterns: ['^b/'] },
];

describe('repo config `risk` section', () => {
  it('accepts a valid section in a v2 config only', () => {
    expect(repoRoutingConfigIssues({ version: 2, risk: { rules, refactorAllowlist: ['x/**'] } })).toEqual([]);
    expect(repoRoutingConfigIssues({ risk: { rules } })[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['risk'],
    });
    expect(RepoFactoryConfigV2Schema.parse({ version: 2, risk: { rules } }).risk?.rules).toHaveLength(2);
  });

  it('accepts a config without the section', () => {
    expect(repoRoutingConfigIssues({ version: 2 })).toEqual([]);
  });

  it('rejects structural errors with their key path', () => {
    const issues = repoRoutingConfigIssues({ version: 2, risk: { rules: [{ id: 'a', tier: 'huge', globs: [] }] } });
    expect(issues.map((i) => i.path.join('.'))).toEqual(['risk.rules.0.tier']);
    const unknown = repoRoutingConfigIssues({ version: 2, risk: { rules, extra: true } });
    expect(unknown[0]).toMatchObject({ code: 'unrecognized_keys', path: ['risk'], keys: ['extra'] });
  });

  it('runs the risk rule validator once the structure is valid', () => {
    const dup = repoRoutingConfigIssues({ version: 2, risk: { rules: [rules[0], rules[0]] } });
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({ path: ['risk', 'rules', 1], message: expect.stringContaining('duplicate id "a"') });
    const noMatcher = repoRoutingConfigIssues({ version: 2, risk: { rules: [{ id: 'a', tier: 'low' }] } });
    expect(noMatcher[0]?.message).toContain('at least one matcher');
    const badRegex = repoRoutingConfigIssues({
      version: 2,
      risk: { rules: [{ id: 'a', tier: 'low', patterns: ['('] }] },
    });
    expect(badRegex[0]?.message).toContain('does not compile');
    const emptyGlob = repoRoutingConfigIssues({ version: 2, risk: { rules, refactorAllowlist: [''] } });
    expect(emptyGlob[0]).toMatchObject({ path: ['risk'], message: expect.stringContaining('refactorAllowlist') });
  });

  it('documents the section in the JSON Schema', () => {
    const schema = z.toJSONSchema(RepoFactoryConfigV2Schema, { io: 'input' }) as {
      properties: Record<string, { description?: string; properties?: Record<string, unknown> }>;
    };
    expect(schema.properties.risk?.description).toMatch(/Repo risk policy/);
    expect(Object.keys(schema.properties.risk?.properties ?? {})).toEqual(['rules', 'refactorAllowlist']);
  });
});
