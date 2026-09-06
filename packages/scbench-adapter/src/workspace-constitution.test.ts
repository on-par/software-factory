import { describe, expect, it } from 'vitest';

import { WORKSPACE_CONSTITUTION } from './workspace-constitution.js';

describe('WORKSPACE_CONSTITUTION', () => {
  it('carries frontmatter the core constitution loader can parse, plus a non-empty body', () => {
    expect(WORKSPACE_CONSTITUTION.startsWith('---\n')).toBe(true);
    const closing = WORKSPACE_CONSTITUTION.indexOf('\n---\n', 4);
    expect(closing).toBeGreaterThan(0);
    const body = WORKSPACE_CONSTITUTION.slice(closing + '\n---\n'.length);
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it('mandates clean SIGINT/SIGTERM shutdown of long-running modes', () => {
    expect(WORKSPACE_CONSTITUTION).toContain('SIGINT');
    expect(WORKSPACE_CONSTITUTION).toContain('SIGTERM');
    expect(WORKSPACE_CONSTITUTION).toMatch(/long-running/i);
    expect(WORKSPACE_CONSTITUTION).toMatch(/watch/i);
  });

  it('leaks no hidden-test name or per-problem hint', () => {
    expect(WORKSPACE_CONSTITUTION).not.toContain('test_sigint_shutdown');
    expect(WORKSPACE_CONSTITUTION).not.toContain('cfgpipe');
  });

  it('names the ADR-decided factory-authored test location', () => {
    expect(WORKSPACE_CONSTITUTION).toContain('.factory/tests/');
    expect(WORKSPACE_CONSTITUTION).toContain('ADR-0081');
  });
});
