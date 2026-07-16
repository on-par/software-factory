import { followEvents, formatEventLine, colorEnabled, type FactoryEvent } from '@on-par/factory-core';

/**
 * Plain-line fallback printer — mirrors `logEvent`'s console output
 * (`[factory] ${type} #${issue}: ${msg}`) so non-TTY / Ink-init-failure
 * sessions still see the same live feed `factory logs --follow` would show.
 */
export function followPlain(
  eventsFile: string,
  out: NodeJS.WritableStream = process.stdout,
  follow: typeof followEvents = followEvents,
): () => void {
  return follow(
    eventsFile,
    (e: FactoryEvent) => {
      out.write(formatEventLine(e.type, e.issue, e.msg, { color: colorEnabled(out as { isTTY?: boolean }) }) + '\n');
    },
    { fromStart: true },
  );
}
