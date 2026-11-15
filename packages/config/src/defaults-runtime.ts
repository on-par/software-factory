export const defaultBudget = { usageCapUsd: 227, watchdogStopAt: 0.75 } as const;

export const defaultSchemaFields = {
  mergeAdmin: false,
  processGroupGraceMs: 5000,
  adrMandate: false,
  workspaceBackend: 'host',
  trackerKind: 'github',
  ciComment: 'Set FACTORY_SKIP_CI=1 to skip waiting for GitHub Actions CI before merging',
} as const;
