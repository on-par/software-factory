// packages/cli/src/cli/queue-output.ts — text rendering for `factory queue add` and `factory unpark`, incl. order collisions (#2988).

import { styleText } from 'node:util';

import type { EnqueueResult, OrderCollision, UnparkJson } from '@on-par/factory-core/internal';

export interface QueueOutputLine {
  stream: 'out' | 'err';
  text: string;
}

export function formatOrderCollision(issue: number, collision: OrderCollision, position: number): string {
  const holders = collision.heldBy.map((n) => `#${n}`).join(', ');
  return `#${issue} would collide with factory:order:${collision.order} held by ${holders} — bumped to position ${position}`;
}

export function renderQueueAddLines(lane: string, results: readonly EnqueueResult[]): QueueOutputLine[] {
  const lines: QueueOutputLine[] = [];
  for (const r of results) {
    if (r.outcome === 'queued') {
      lines.push({
        stream: 'out',
        text: styleText('green', `#${r.issue} queued → lane ${lane}, position ${r.position}`),
      });
      if (r.collision && r.position !== undefined) {
        lines.push({
          stream: 'out',
          text: styleText('yellow', formatOrderCollision(r.issue, r.collision, r.position)),
        });
      }
    } else if (r.outcome === 'already-queued') {
      lines.push({ stream: 'out', text: `#${r.issue} already queued — skipped` });
    } else {
      lines.push({ stream: 'err', text: styleText('red', `#${r.issue} failed — ${r.detail}`) });
    }
  }
  return lines;
}

export function renderUnparkLines(result: UnparkJson): string[] {
  const lines = [styleText('green', `#${result.issue} unparked → lane ${result.lane}, position ${result.order}`)];
  if (result.collision) {
    lines.push(styleText('yellow', formatOrderCollision(result.issue, result.collision, result.order)));
  }
  return lines;
}
