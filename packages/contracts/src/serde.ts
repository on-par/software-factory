// src/serde.ts — String<->object helpers for the contract seam: both apps hand these
// payloads across a process boundary, so validation happens at the edge (#466).
import type { z } from 'zod';

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

/** Validate then JSON-encode. Throws ZodError when `value` does not satisfy `schema`. */
export function serialize<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: T): string {
  return JSON.stringify(schema.parse(value));
}

/** JSON-decode then validate. Throws SyntaxError or ZodError. */
export function deserialize<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: string): T {
  return schema.parse(JSON.parse(raw));
}

export type DeserializeResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Non-throwing `deserialize`. Malformed JSON reports `['json: <message>']`. */
export function tryDeserialize<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: string): DeserializeResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, errors: [`json: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const result = schema.safeParse(parsed);
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: formatIssues(result.error) };
}
