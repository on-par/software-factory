// packages/cli/src/stream-session.ts — starts the command output stream session; cli.ts loads it only after the Node version gate.

import { startCommandStreamSession } from '@on-par/factory-core/internal';

import { readCliVersion } from './entry.js';

export function startStreamSession(): void {
  startCommandStreamSession({ version: readCliVersion() });
}
