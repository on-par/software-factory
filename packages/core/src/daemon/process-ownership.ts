import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
export function recordOwnedProcess(file: string, pid: number): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${pid}\n`, { mode: 0o600 });
}
export function hasOwnedProcesses(file: string): boolean {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .some((value) => {
      if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error('Invalid process ownership record');
      return processAlive(Number(value));
    });
}
export async function waitForOwnedProcesses(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (hasOwnedProcesses(file)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}
