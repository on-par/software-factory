// Defaults that FactoryConfigSchema and the repo budget resolvers read but that
// defaultFactoryConfig does not spell out (#3444, ADR-0033).

/** Repo budget fallbacks: `budget.capUsd` and `budget.watchdog.stopAt` when neither repo config nor env sets them. */
export const defaultBudget = { usageCapUsd: 227, watchdogStopAt: 0.75 } as const;

/** Schema-only defaults for FactoryConfigSchema fields that defaultFactoryConfig leaves out. */
export const defaultSchemaFields = {
  mergeAdmin: false,
  processGroupGraceMs: 5000,
  adrMandate: false,
  workspaceBackend: 'host',
  trackerKind: 'github',
  ciComment: 'Set FACTORY_SKIP_CI=1 to skip waiting for GitHub Actions CI before merging',
} as const;
