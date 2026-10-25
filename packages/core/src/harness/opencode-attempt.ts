// src/harness/opencode-attempt.ts — Per-attempt diagnostics for empty opencode runs (#694).

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TRACE_STDOUT_BYTES = 256 * 1024;
const TRACE_STDERR_BYTES = 64 * 1024;

export interface OpenCodeAttemptOutput {
  stdout: string;
  stderr: string;
}

/** One-line summary of an opencode attempt: sizes, event/step counts and how the last step ended.
 *  Separates a tool-call-only final step (`finished=true lastFinish=tool-calls earlierTextChars>0`)
 *  from truncation (`finished=false`) and from no events at all (`events=0`). */
export function describeOpenCodeAttempt(attempt: number, stdout: string, stderr: string): string {
  let events = 0;
  let steps = 0;
  let lastFinish = 'none';
  let openStep = false;
  let outTokens = 0;
  let stepChars = 0;
  let earlierTextChars = 0;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') continue;
    events++;
    if (event.type === 'step_start') {
      steps++;
      openStep = true;
      earlierTextChars += stepChars;
      stepChars = 0;
    } else if (event.type === 'text') {
      const text = event.part?.text;
      if (typeof text === 'string') stepChars += text.trim().length;
    } else if (event.type === 'step_finish') {
      openStep = false;
      const reason = event.part?.reason;
      lastFinish = typeof reason === 'string' && reason ? reason : 'none';
      const out = event.part?.tokens?.output;
      if (typeof out === 'number' && Number.isFinite(out)) outTokens += out;
    }
  }
  return (
    `a${attempt}: stdoutBytes=${Buffer.byteLength(stdout)} stderrBytes=${Buffer.byteLength(stderr)} events=${events} ` +
    `steps=${steps} lastFinish=${lastFinish} finished=${!openStep} outTokens=${outTokens} earlierTextChars=${earlierTextChars}`
  );
}

/** Writes the raw (capped) output of each attempt to a JSON file in the OS temp dir, so nothing lands
 *  in the lane's git diff. Returns the path, or undefined when the write fails. */
export async function writeOpenCodeEmptyTrace(
  task: string,
  model: string,
  promptBytes: number,
  attempts: readonly OpenCodeAttemptOutput[],
): Promise<string | undefined> {
  try {
    const dir = await mkdtemp(join(tmpdir(), 'factory-opencode-trace-'));
    const path = join(dir, 'trace.json');
    const body = {
      harness: 'opencode',
      model,
      task,
      promptBytes,
      attempts: attempts.map((a, i) => ({
        attempt: i + 1,
        stdout: a.stdout.slice(-TRACE_STDOUT_BYTES),
        stderr: a.stderr.slice(-TRACE_STDERR_BYTES),
      })),
    };
    await writeFile(path, JSON.stringify(body, null, 2), 'utf8');
    return path;
  } catch {
    return undefined;
  }
}
