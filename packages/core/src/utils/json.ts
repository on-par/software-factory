export interface JsonObjectCandidate {
  text: string;
  value: unknown;
}

function tryParseJson(text: string): { value: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return { value };
  } catch {
    return undefined;
  }
}

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
        const parsed = tryParseJson(candidate);
        if (parsed) {
          candidates.push({ text: candidate, value: parsed.value });
          start = i;
        }
        break;
      }
    }
  }

  return candidates;
}
