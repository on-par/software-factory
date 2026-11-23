const ENRICHED_START = '<!-- factory:enriched -->';
const ENRICHED_END = '<!-- /factory:enriched -->';

export function stripEnrichedBlock(body: string): string {
  let result = body;
  let start = result.indexOf(ENRICHED_START);
  while (start >= 0) {
    const end = result.indexOf(ENRICHED_END, start + ENRICHED_START.length);
    if (end < 0) {
      result = result.slice(0, start).trimEnd();
    } else {
      const before = result.slice(0, start);
      const after = result.slice(end + ENRICHED_END.length);
      result = after.trim() === '' ? before.trimEnd() : `${before}${after.replace(/^[ \t]*\r?\n/, '')}`;
    }
    start = result.indexOf(ENRICHED_START);
  }
  return result;
}
