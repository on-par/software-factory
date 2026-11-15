import { describe, expect, it } from 'vitest';
import { defaultBudget, defaultSchemaFields } from './index.js';

describe('defaults-runtime', () => {
  it('pins defaultBudget values', () => {
    expect(defaultBudget).toEqual({ usageCapUsd: 227, watchdogStopAt: 0.75 });
  });

  it('pins defaultSchemaFields values', () => {
    expect(defaultSchemaFields).toEqual({
      mergeAdmin: false,
      processGroupGraceMs: 5000,
      adrMandate: false,
      workspaceBackend: 'host',
      trackerKind: 'github',
      ciComment: 'Set FACTORY_SKIP_CI=1 to skip waiting for GitHub Actions CI before merging',
    });
  });
});
