import { readRepoConfigFile } from './repo-config-file.js';

/** A daemon supplies one immutable snapshot to its child process. Missing means local CLI policy. */
export function runConfigSource(): string | undefined {
  return process.env.FACTORY_RUN_CONFIG_JSON;
}

/** The config file a one-shot run snapshotted; undefined for a daemon snapshot or when there is none. */
export function runConfigOrigin(): string | undefined {
  return process.env.FACTORY_RUN_CONFIG_ORIGIN;
}

let holders = 0;

/** One config source per run (#3600): snapshot the source checkout's repo config file into
 *  FACTORY_RUN_CONFIG_JSON, so every loader sees the file the run started from. CHECK reads config
 *  from the worktree, which has no `.factory/` when the source keeps it untracked. A snapshot that
 *  is already set (the daemon's) wins. Returns a release; the snapshot is cleared when the last
 *  holder (concurrent lanes of one process share it) releases. Throws on a malformed file. */
export function holdRunConfigSnapshot(configPath: string): () => void {
  if (holders === 0) {
    if (runConfigSource() !== undefined) return () => {};
    const raw = readRepoConfigFile(configPath);
    if (raw === undefined) return () => {};
    process.env.FACTORY_RUN_CONFIG_JSON = JSON.stringify(raw);
    process.env.FACTORY_RUN_CONFIG_ORIGIN = configPath;
  }
  holders++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders > 0) return;
    delete process.env.FACTORY_RUN_CONFIG_JSON;
    delete process.env.FACTORY_RUN_CONFIG_ORIGIN;
  };
}
