# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Removed

- Removed the unstarted hosted-exec control plane (epic #895; #940/#944 parked).
  The `factory hosted smoke`, `factory hosted runner` and `factory hosted queue`
  commands are gone, along with the `FACTORY_HOSTED_EXEC` flag. Removed from
  `@on-par/factory-core`'s root export: the hosted job store (in-memory and
  SQLite, `resolveHostedJobStore`), control-plane server and HTTP clients,
  runners, watchdog sweep, job summaries, smoke, `runContainerJob`, and the
  provider/GitHub authority brokers (`withAuthority`, `redactSecrets`,
  `AUTHORITY_REDACTION_MASK`, `prepareGitHubAuthority`, `prototypeFallbackMint`,
  `redactGitHubCredential`, `resolveHostedAuthority`). Removed from
  `@on-par/contracts`: the hosted-job and provider-session schemas,
  `hostedExecEnabled`, `HOSTED_EXEC_FLAG` and the `runHostedContractDemo` demo.
  The disposable-docker lane backend (`laneContainerName`,
  `provisionLaneContainer`, `createDockerEngine`, orphan-container reaping) is
  unchanged; `ContainerEngine` now carries only its lane methods.
- Removed the bundled `camp-somewhere-cli` constitution. This was a breaking
  change for anyone relying on the bundled constitution for that product; seed
  your own repo's constitution instead with `factory constitution --init <product>`.
- Removed unwired subsystems that had no runtime consumer (optimization review
  2026-09, §8):
  - **Breaking (root `@on-par/factory-core` API):** the discovery loop and its
    exports — `runDiscoveryScan`, `DEFAULT_MAX_CANDIDATES`, `authorDraftEpic`,
    `DEFAULT_OWNER_QUESTIONS`, `DISCOVERY_LABEL`, `EXPLORING_LABEL`,
    `ideaMarker`, `advanceDraftEpic`, `classifyLifecycle`, `seedStories`,
    `renderStoryBody`, `DEFAULT_MAX_STORIES`, `ARCHIVED_LABEL`, `READY_LABEL`,
    `VALIDATED_LABEL`, `WONTFIX_LABEL`, and their types. The `discovery` config
    section is gone; an existing `.factory/config.json` carrying it still
    loads (the key is ignored).
  - **Breaking (`@on-par/repo-context`):** `createGitHubContentsReader`,
    `DEFAULT_GITHUB_API_BASE_URL` and the `FetchLike*` types. The fs and
    in-memory readers remain; `DEFAULT_MAX_FILE_BYTES` now lives in `fs.ts`.
  - `./internal` only: the factoryd in-process engine supervisor
    (`superviseEngine`, `superviseActiveRepos`, `runDaemonRepo`, and the
    `engine-restarted` event kind); the `UsageCoordinator` stack
    (`createUsageCoordinator`, grant ledger, `createLaneScheduler`,
    `createLocalUsageCoordinator`, `selectUsageCoordinator`,
    `isCappedModel`); failure fingerprinting and auto bug filing
    (`captureFailure`, `fingerprintFailure`, `fileBug`, `findMatchingIssue`,
    `createOctokitFilingClient`, `evaluateFilingPolicy` and the filing
    ledger). `isAutoMergeBlocked` and `resolveFilingPolicy` stay; the unread
    `filing.*` keys other than `selfFixLabel` are dropped (ignored if present).
  - ADR-0005 is Deprecated, ADR-0066 Deprecated, ADR-0067 Superseded.
