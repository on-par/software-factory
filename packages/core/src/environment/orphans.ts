// src/environment/orphans.ts — Startup-reaper orphan pass: identify processes
// still squatting a dead lane's leased port, and kill only those whose pgid
// was actually recorded against that lane's lease (conservative: everything
// else is report-only, never terminated).

import { defaultExecFn, type ExecFn } from '../utils/exec.js';
import type { ReapedLease } from './index.js';
import { killProcessGroup } from './process-groups.js';

export interface PortListener {
  pid: number;
  pgid: number;
  command: string;
}

export type FindPortListenersFn = (port: number) => Promise<PortListener[]>;

const LSOF_TIMEOUT_MS = 5000;

/** Lists processes currently LISTENing on `port` via `lsof` + `ps`. Any
 *  failure (lsof absent, no listeners, parse error) resolves to `[]` —
 *  this is a best-effort report-only probe, never a hard dependency. */
export async function defaultFindPortListeners(port: number, execFn: ExecFn = defaultExecFn): Promise<PortListener[]> {
  let pids: string[];
  try {
    const { stdout } = await execFn(`lsof -nP -tiTCP:${port} -sTCP:LISTEN`, { timeoutMs: LSOF_TIMEOUT_MS });
    pids = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }

  if (pids.length === 0) return [];

  try {
    const { stdout } = await execFn(`ps -o pid=,pgid=,command= -p ${pids.join(',')}`, {
      timeoutMs: LSOF_TIMEOUT_MS,
    });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!match) return undefined;
        const [, pidStr, pgidStr, command] = match;
        return { pid: Number(pidStr), pgid: Number(pgidStr), command };
      })
      .filter((row): row is PortListener => row !== undefined);
  } catch {
    return [];
  }
}

export interface OrphanEvent {
  action: 'killed' | 'reported';
  worktreeId: string;
  port: number;
  pid: number;
  pgid: number;
  command: string;
}

export async function reapOrphanProcesses(opts: {
  reaped: ReapedLease[];
  findListeners?: FindPortListenersFn;
  killGroup?: typeof killProcessGroup;
  graceMs?: number;
  onEvent?: (evt: OrphanEvent) => void;
}): Promise<OrphanEvent[]> {
  const findListeners = opts.findListeners ?? defaultFindPortListeners;
  const killGroup = opts.killGroup ?? killProcessGroup;

  const events: OrphanEvent[] = [];

  for (const { lease } of opts.reaped) {
    const listeners = await findListeners(lease.port);
    const recordedPgids = new Set(lease.pgids ?? []);

    for (const listener of listeners) {
      if (recordedPgids.has(listener.pgid)) {
        await killGroup(listener.pgid, { graceMs: opts.graceMs });
        const event: OrphanEvent = {
          action: 'killed',
          worktreeId: lease.worktreeId,
          port: lease.port,
          pid: listener.pid,
          pgid: listener.pgid,
          command: listener.command,
        };
        events.push(event);
        opts.onEvent?.(event);
      } else {
        const event: OrphanEvent = {
          action: 'reported',
          worktreeId: lease.worktreeId,
          port: lease.port,
          pid: listener.pid,
          pgid: listener.pgid,
          command: listener.command,
        };
        events.push(event);
        opts.onEvent?.(event);
      }
    }
  }

  return events;
}
