// packages/core/src/config/precedence.ts — the one flag › repo › env › default walk every
// policy resolver shares, so the engine and the app can't carry diverging copies of it.

/** Where a resolved policy value came from. `'flag'` is an explicit per-invocation CLI flag
 *  and outranks every other source. */
export type ConfigSource = 'flag' | 'repo' | 'env' | 'default';

export interface PrecedenceCandidate<T, S extends Exclude<ConfigSource, 'default'> = Exclude<ConfigSource, 'default'>> {
  source: S;
  /** Lazy: called only when every earlier candidate returned undefined. Return undefined to
   *  fall through; may throw on a malformed value (so env validation only fires when reached). */
  read: () => T | undefined;
}

export interface ResolvedValue<T, S extends ConfigSource = ConfigSource> {
  value: T;
  source: S;
}

/** Return the first candidate whose `read()` is not undefined, with its source; otherwise
 *  `fallback` with source `'default'`. */
export function resolvePrecedence<T, S extends Exclude<ConfigSource, 'default'> = Exclude<ConfigSource, 'default'>>(
  candidates: readonly PrecedenceCandidate<T, S>[],
  fallback: T,
): ResolvedValue<T, S | 'default'> {
  for (const candidate of candidates) {
    const value = candidate.read();
    if (value !== undefined) return { value, source: candidate.source };
  }
  return { value: fallback, source: 'default' };
}
