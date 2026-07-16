// src/utils/json.ts — string-aware balanced-brace JSON object extraction from free-form text

export interface JsonObjectCandidate {
  /** Raw source text of the balanced object, exactly as it appeared in the output */
  text: string;
  /** The JSON.parse result */
  value: unknown;
}

/**
 * Scan free-form model output for top-level balanced JSON objects and return
 * every candidate that parses, in order of appearance. String-aware: braces
 * inside JSON string values (and escaped quotes) do not affect brace depth.
 */
export function extractJsonObjects(output: string): JsonObjectCandidate[] {
  const candidates: JsonObjectCandidate[] = [];

  for (let start = 0; start < output.length; start++) {
    if (output[start] !== '{') continue;

    let depth = 0;
    let inString = false;

    for (let i = start; i < output.length; i++) {
      const ch = output[i];

      if (inString) {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;

      if (depth === 0) {
        const candidate = output.slice(start, i + 1);
        try {
          const value: unknown = JSON.parse(candidate);
          candidates.push({ text: candidate, value });
          start = i;
        } catch {
          // Keep scanning for the next balanced JSON object.
        }
        break;
      }
    }
  }

  return candidates;
}
