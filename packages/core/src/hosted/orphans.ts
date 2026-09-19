// src/hosted/orphans.ts — Orphan `sf-job-*`/`factory.managed=true` Docker container
// scan + reap for `factory doctor --reconcile` (#1527). Mirrors ./docker.ts's shell-string
// ExecFn pattern so every call goes through the injected exec function and tests never
// touch a real docker daemon.

import { defaultExecFn, type ExecFn } from '../utils/exec.js';

export interface OrphanContainer {
  id: string;
  name: string;
}

export interface ReapedContainer {
  name: string;
  id: string;
  removed: boolean;
  detail: string;
}

function quote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

const STOPPED_FILTERS = ["--filter 'status=exited'", "--filter 'status=dead'"];

async function psFilter(exec: ExecFn, extraFilter: string): Promise<OrphanContainer[]> {
  const cmd = ['docker ps -a', ...STOPPED_FILTERS, extraFilter, "--format '{{.ID}}\\t{{.Names}}'"].join(' ');
  const { stdout } = await exec(cmd, {});
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id, name] = l.split('\t');
      return { id, name };
    });
}

/** Lists stopped containers matching the `sf-job-*` name convention or the
 *  `factory.managed=true` label — the two `docker ps -a` filters are issued separately
 *  and merged by ID since Docker ANDs different `--filter` keys within one call. Only
 *  ever considers a container Docker itself already reports as exited/dead: a hosted-exec
 *  container's `docker run` is one-shot and synchronous, so a stopped match is always
 *  leftover teardown debris, never in-flight work. */
export async function listOrphanContainers(exec: ExecFn = defaultExecFn): Promise<OrphanContainer[]> {
  const [byName, byLabel] = await Promise.all([
    psFilter(exec, "--filter 'name=sf-job-'"),
    psFilter(exec, "--filter 'label=factory.managed=true'"),
  ]);
  const byId = new Map<string, OrphanContainer>();
  for (const c of [...byName, ...byLabel]) byId.set(c.id, c);
  return [...byId.values()];
}

/** Removes each given container with `docker rm -f -v` (the `-v` flag also deletes its
 *  anonymous volumes as part of container removal). Never throws: a single container's
 *  removal failure is reported in the returned row so every other container still gets
 *  attempted and the caller can surface the failure. */
export async function reapOrphanContainers(
  containers: readonly OrphanContainer[],
  exec: ExecFn = defaultExecFn,
): Promise<ReapedContainer[]> {
  const results: ReapedContainer[] = [];
  for (const c of containers) {
    try {
      await exec(`docker rm -f -v ${quote(c.name)}`, {});
      results.push({ name: c.name, id: c.id, removed: true, detail: `docker rm -f -v ${c.name} ok` });
    } catch (err: any) {
      results.push({
        name: c.name,
        id: c.id,
        removed: false,
        detail: `docker rm -f -v ${c.name} failed: ${err?.stderr ?? err?.message ?? String(err)}`,
      });
    }
  }
  return results;
}
