// packages/cli/src/cli/lane-environment-pause-error.ts — environment pause signal thrown by ship (#1928)

/** CHECK found every failing checker also failing on the base SHA (#1928): the issue is
 *  released to queued (not parked) and the lane pauses. */
export class LaneEnvironmentPauseError extends Error {
  readonly baseSha: string;
  readonly failingChecks: string[];
  readonly failureSignature?: string;
  /** BUILD output was kept for `factory resume --from check` (#2564); runLane must not reap it. */
  readonly buildPreserved?: boolean;
  /** Red only because a base compile timeout awaits green CI (#3186). */
  readonly awaitingCi?: boolean;
  readonly confirmedLocally?: boolean;

  constructor(
    message: string,
    failure: {
      baseSha: string;
      failingChecks: string[];
      failureSignature?: string;
      buildPreserved?: boolean;
      awaitingCi?: boolean;
      confirmedLocally?: boolean;
    },
  ) {
    super(message);
    if (failure.awaitingCi !== undefined) this.awaitingCi = failure.awaitingCi;
    if (failure.confirmedLocally !== undefined) this.confirmedLocally = failure.confirmedLocally;
    if (failure.buildPreserved !== undefined) this.buildPreserved = failure.buildPreserved;
    this.baseSha = failure.baseSha;
    this.failingChecks = failure.failingChecks;
    if (failure.failureSignature !== undefined) this.failureSignature = failure.failureSignature;
  }
}
