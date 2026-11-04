import { runConfigSource } from './run-config-env.js';
import { resolveRunConfigLadder, type RunConfigLadder } from './run-config-ladder.js';

export { runConfigOrigin, runConfigSource } from './run-config-env.js';

let holders = 0;
let lastLadder: RunConfigLadder | undefined;

/** The ladder the latest holdRunConfigSnapshot resolved (#3906), for the run log. */
export function lastRunConfigLadder(): RunConfigLadder | undefined {
  return lastLadder;
}

/** One config source per run (#3600): snapshot the source checkout's repo config file into
 *  FACTORY_RUN_CONFIG_JSON, so every loader sees the file the run started from. CHECK reads config
 *  from the worktree, which has no `.factory/` when the source keeps it untracked. A snapshot that
 *  is already set (the daemon's) wins. Returns a release; the snapshot is cleared when the last
 *  holder (concurrent lanes of one process share it) releases. Throws on a malformed file or an invalid override (#3906). */
export function holdRunConfigSnapshot(configPath: string, env: NodeJS.ProcessEnv = process.env): () => void {
  if (holders === 0) {
    if (runConfigSource() !== undefined) return () => {};
    const ladder = resolveRunConfigLadder(configPath, env);
    lastLadder = ladder;
    if (ladder.raw === undefined) return () => {};
    process.env.FACTORY_RUN_CONFIG_JSON = JSON.stringify(ladder.raw);
    process.env.FACTORY_RUN_CONFIG_ORIGIN =
      ladder.path ?? (ladder.source === 'packaged defaults' ? 'FACTORY_CONFIG_OVERRIDES' : ladder.source);
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
