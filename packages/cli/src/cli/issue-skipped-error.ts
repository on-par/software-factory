export class IssueSkippedError extends Error {
  constructor(
    message: string,
    readonly reason: 'already-closed',
  ) {
    super(message);
  }
}
