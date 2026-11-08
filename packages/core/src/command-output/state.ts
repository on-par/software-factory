// src/command-output/state.ts — the one owner of this process's command output state: the process tag and
// command sequence shared by every sink, the file sink's session counts, and the once-per-process warnings.

/** Process start time (epoch ms) and pid: names this process's session and every command id. */
export const PROCESS_TAG = `${Math.round(performance.timeOrigin)}-${process.pid}`;

let sequence = 0;

/** Next command id, `<process tag>-<6-digit sequence>`; the NDJSON file name and the OTLP records share it. */
export function nextCommandId(): string {
  return `${PROCESS_TAG}-${String(++sequence).padStart(6, '0')}`;
}

/** Counts reported in the file sink's session end file, reset when a file session starts. */
export const fileStats = { commands: 0, writeErrors: 0, unavailable: false };

/** Messages already printed in this process, so a broken sink warns once, not once per command. */
const warned = new Set<string>();

/** Prints `message` through `warn` the first time only. A throwing warning sink never reaches the caller. */
export function warnOnce(message: string, warn: (message: string) => void = (m) => console.warn(m)): void {
  if (warned.has(message)) return;
  warned.add(message);
  try {
    warn(message);
  } catch {
    // a broken warning sink must not reach the command
  }
}
