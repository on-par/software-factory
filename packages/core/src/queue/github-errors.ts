// packages/core/src/queue/github-errors.ts — GitHub status-code predicates shared by the Octokit queue adapters.

export function notFoundError(err: unknown): boolean {
  const view = err as { status?: unknown };
  return view.status === 404;
}

export function labelExistsError(err: unknown): boolean {
  const view = err as { status?: unknown };
  return view.status === 422;
}
