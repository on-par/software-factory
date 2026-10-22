/** Sections FactoryConfigSchema always fills. Hand-built config fixtures spread these in so resolvers see a parsed shape. */
export const parsedConfigSections = {
  timeouts: {
    plan_seconds: 1800,
    build_seconds: 7200,
    check_seconds: 1800,
    approval_seconds: 1800,
    tests_seconds: 300,
    compile_seconds: 120,
  },
  kpis: { defectWindowDays: 14 },
  ingest: { enabled: false, label: 'ready', lane: 'auto', maxPerCycle: 20 },
  environment: {
    ports: { enabled: true, range: [3100, 3999] },
    processGroups: { graceMs: 5000 },
    proxy: { enabled: false, port: 80, domain: 'factory.localhost' },
  },
};
