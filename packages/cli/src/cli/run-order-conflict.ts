// packages/cli/src/cli/run-order-conflict.ts — surfaces a queue order conflict to stderr and the events log (#3890, split from run.ts).

import { styleText } from 'node:util';

import { formatQueueOrderConflict, logEvent } from '@on-par/factory-core/internal';
import type { QueueOrderConflict } from '@on-par/factory-core/internal';

export function reportQueueOrderConflict(eventsFile: string, conflict: QueueOrderConflict): void {
  const line = formatQueueOrderConflict(conflict);
  console.error(styleText('yellow', `factory: ${line}`));
  logEvent(eventsFile, 'queue_order_conflict', conflict.issues.join(','), line, { lane: conflict.lane });
}
