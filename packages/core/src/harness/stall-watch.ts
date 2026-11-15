import { killProcessGroup } from '../environment/process-groups.js';
import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';

export const STALL_SECONDS_ENV = 'FACTORY_HARNESS_STALL_SECONDS';
export const DEFAULT_STALL_SECONDS = 900;
export const DEFAULT_STALL_INTERVAL_MS = 30_000;

const PROBE_TIMEOUT_MS = 5000;
const IDLE_CPU_FRACTION = 0.01;

export function resolveStallSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STALL_SECONDS_ENV]?.trim();
  if (raw === '0') return 0;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 && Math.floor(n) > 0 ? Math.floor(n) : DEFAULT_STALL_SECONDS;
}

export interface ProcessActivitySample {
  cpuSeconds: number;
  tcpConnections: number;
}

export type ProcessActivityProbe = (pgid: number) => Promise<ProcessActivitySample | undefined>;

export function parsePsCpuSeconds(time: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(time.trim());
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

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
