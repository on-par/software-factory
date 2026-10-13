// packages/core/src/config/schema-issue.ts — dependency-free shape shared by the config loaders and
// the doctor schema scan (#2611).

export interface ConfigSchemaIssue {
  path: (string | number)[];
  message: string;
  /** unrecognized_keys only */
  keys?: string[];
}

interface ZodLikeIssue {
  path: PropertyKey[];
  message: string;
  keys?: unknown;
}

export function toConfigSchemaIssue(i: ZodLikeIssue): ConfigSchemaIssue {
  return {
    path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
    message: i.message,
    keys: Array.isArray(i.keys) ? i.keys.map(String) : undefined,
  };
}
