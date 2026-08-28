// packages/cli/src/cli/merge-scope.ts — warn when merge env vars are set for a command that ignores them

/** The env vars that enable autonomous merge — honored by `factory run`/`factory land`,
 *  never by `factory ship`, which always stops at a ready-for-review PR (#978). */
export const MERGE_SCOPE_ENV_VARS = ['FACTORY_MERGE', 'FACTORY_MERGE_ADMIN'] as const;

/** One advisory line when a merge env var is set for a command that cannot honor it,
 *  or undefined when none is set. Pure: reads only the passed env bag. */
export function mergeScopeNotice(env: NodeJS.ProcessEnv, issueNum: number): string | undefined {
  const set = MERGE_SCOPE_ENV_VARS.filter((name) => env[name] === '1');
  if (set.length === 0) return undefined;
  return (
    `factory: ${set.map((n) => `${n}=1`).join(', ')} ignored — factory ship always stops at ` +
    `ready-for-review; use "factory land ${issueNum}" after review, or "factory run" to merge automatically`
  );
}
