/** A daemon supplies one immutable snapshot to its child process. Missing means local CLI policy. */
export function runConfigSource(): string | undefined {
  return process.env.FACTORY_RUN_CONFIG_JSON;
}
