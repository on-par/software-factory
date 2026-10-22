// packages/config/src/unknown-keys.ts — find config keys a known-key tree does not list (#3568). Pure, zero-dependency.

/** A tree of known config keys: `true` is a leaf (any value, not walked); an object maps each known key to its
 *  subtree. The key `ANY_CONFIG_KEY` means any key is allowed, and its value is the subtree for each. */
export type KnownConfigKeys = { readonly [key: string]: KnownConfigKeys | true };

export const ANY_CONFIG_KEY = '*';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walk(raw: unknown, known: KnownConfigKeys, prefix: string, out: string[]): void {
  if (!isPlainRecord(raw)) return;
  for (const key of Object.keys(raw)) {
    const subtree = known[key] ?? known[ANY_CONFIG_KEY];
    if (subtree === undefined) out.push(prefix + key);
    else if (subtree !== true) walk(raw[key], subtree, `${prefix}${key}.`, out);
  }
}

/** Sorted dotted paths of the keys in `raw` that `known` does not list. */
export function findUnknownConfigKeys(raw: unknown, known: KnownConfigKeys): string[] {
  const out: string[] = [];
  walk(raw, known, '', out);
  return out.sort();
}
