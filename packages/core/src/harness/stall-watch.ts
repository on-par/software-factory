// src/harness/stall-watch.ts — Idle-process stall detector for harness children (#694).

import { killProcessGroup } from '../environment/process-groups.js';
import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';

export const STALL_SECONDS_ENV = 'FACTORY_HARNESS_STALL_SECONDS';
export const DEFAULT_STALL_SECONDS = 900;
export const DEFAULT_STALL_INTERVAL_MS = 30_000;

const PROBE_TIMEOUT_MS = 5000;
/** CPU growth at or below this fraction of the sample interval counts as idle. */
const IDLE_CPU_FRACTION = 0.01;

/** Stall threshold in seconds: `0` disables, unset/invalid falls back to the default. */
export function resolveStallSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STALL_SECONDS_ENV]?.trim();
  if (raw === '0') return 0;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 && Math.floor(n) > 0 ? Math.floor(n) : DEFAULT_STALL_SECONDS;
}

export interface ProcessActivitySample {
  /** Summed cumulative CPU time of every pid in the group. */
  cpuSeconds: number;
  /** Established TCP connections that leave the group. */
  tcpConnections: number;
}

/** `undefined` means unknown, which the watch treats as activity. */
export type ProcessActivityProbe = (pgid: number) => Promise<ProcessActivitySample | undefined>;

/** Parses ps cumulative CPU time: `mm:ss`, `mm:ss.cc`, `hh:mm:ss`, `dd-hh:mm:ss`. */
export function parsePsCpuSeconds(time: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(time.trim());
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** Counts `lsof -F n` connections whose reverse endpoint pair is not also open in the group
 *  (a private loopback server/client pair is internal and does not count as network use). */
export function countExternalTcpConnections(lsofFieldOutput: string): number {
  const conns = new Set<string>();
  for (const line of lsofFieldOutput.split('\n')) {
    if (line.startsWith('n') && line.includes('->')) conns.add(line.slice(1).trim());
  }
  let external = 0;
  for (const conn of conns) {
    const [local, remote] = conn.split('->');
    if (!conns.has(`${remote}->${local}`)) external++;
  }
  return external;
}

/** Samples a process group's CPU time and external TCP connections via `ps` and `lsof`.
 *  Never throws: any failure (win32, missing tool, parse error) resolves to undefined. */
export async function defaultProcessActivityProbe(
  pgid: number,
  execFn: ExecFn = defaultExecFn,
): Promise<ProcessActivitySample | undefined> {
  if (process.platform === 'win32') return undefined;
  const pids: string[] = [];
  let cpuSeconds = 0;
  try {
    const { stdout } = await execFn('ps -A -o pid=,pgid=,time=', { timeoutMs: PROBE_TIMEOUT_MS });
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
      if (!match || Number(match[2]) !== pgid) continue;
      const cpu = parsePsCpuSeconds(match[3]);
      if (cpu === undefined) return undefined;
      pids.push(match[1]);
      cpuSeconds += cpu;
    }
  } catch {
    return undefined;
  }
  if (pids.length === 0) return undefined;

  try {
    const { stdout } = await execFn(`lsof -nP -a -iTCP -sTCP:ESTABLISHED -p ${pids.join(',')} -F n`, {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return { cpuSeconds, tcpConnections: countExternalTcpConnections(stdout) };
  } catch (err: any) {
    // lsof exits 1 when nothing matched.
    if (err?.code === 1 && !err.stdout) return { cpuSeconds, tcpConnections: 0 };
    return undefined;
  }
}

export interface StallWatchOptions {
  stallMs: number;
  intervalMs?: number;
  probe?: ProcessActivityProbe;
  now?: () => number;
  kill?: (pgid: number) => Promise<unknown>;
  onStall: (idleMs: number) => void;
}

export interface StallWatch {
  noteActivity(): void;
  stop(): void;
}

/** Kills `pgid` once it has shown no CPU, external TCP connection or stdout for `stallMs`. */
export function startStallWatch(pgid: number, opts: StallWatchOptions): StallWatch {
  if (opts.stallMs <= 0) return { noteActivity() {}, stop() {} };
  const intervalMs = opts.intervalMs ?? DEFAULT_STALL_INTERVAL_MS;
  const probe = opts.probe ?? defaultProcessActivityProbe;
  const now = opts.now ?? (() => Date.now());
  const kill = opts.kill ?? ((group: number) => killProcessGroup(group));
  let idleSince = now();
  let lastCpu: number | undefined;
  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const sample = await probe(pgid).catch(() => undefined);
      if (stopped) return;
      const idle =
        sample !== undefined &&
        lastCpu !== undefined &&
        sample.cpuSeconds - lastCpu <= (IDLE_CPU_FRACTION * intervalMs) / 1000 &&
        sample.tcpConnections === 0;
      if (sample) lastCpu = sample.cpuSeconds;
      if (!idle) {
        idleSince = now();
        return;
      }
      const idleMs = now() - idleSince;
      if (idleMs >= opts.stallMs) {
        stop();
        opts.onStall(idleMs);
        void Promise.resolve(kill(pgid)).catch(() => undefined);
      }
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  function stop(): void {
    stopped = true;
    clearInterval(timer);
  }
  return {
    noteActivity() {
      idleSince = now();
    },
    stop,
  };
}
