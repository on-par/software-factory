// Leaf accessors for the run's config snapshot env vars. Kept import-free so config/index.ts and repo.ts can
// read them without a cycle through the ladder (which imports both).

/** A daemon supplies one immutable snapshot to its child process. Missing means local CLI policy. */
export function runConfigSource(): string | undefined {
  return process.env.FACTORY_RUN_CONFIG_JSON;
}

/** The config file a one-shot run snapshotted; undefined for a daemon snapshot or when there is none. */
export function runConfigOrigin(): string | undefined {
  return process.env.FACTORY_RUN_CONFIG_ORIGIN;
}
