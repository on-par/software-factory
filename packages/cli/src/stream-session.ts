// packages/cli/src/stream-session.ts — starts and closes the command output session; cli.ts loads it only after the Node version gate.

import { closeCommandOutputSession, startCommandOutputSession } from '@on-par/factory-core/internal';

import { readCliVersion } from './entry.js';

export function startStreamSession(): Promise<void> {
  return startCommandOutputSession({ version: readCliVersion() });
}

/** Flushes exported command output within its budget; a no-op when export is off. */
export async function closeStreamSession(reason: 'exit' | 'error'): Promise<void> {
  await closeCommandOutputSession(reason);
}
