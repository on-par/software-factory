// src/daemon/run-repo.ts — Dispatches orchestration for one daemon-managed
// registry entry, handing the injected runner a lane context whose paths are
// rooted at the entry's registered external stateRoot (#843, #1041).

import { createDaemonLaneContext, type DaemonLaneContext } from './lane-context.js';
import type { RepoRegistryListing } from './registry.js';

/** The orchestration entry the daemon hands a resolved lane context to. Injected as a
 *  port so core never imports the CLI's runLane (contracts <- core <- cli); the daemon
 *  caller wires the real orchestration. */
export type DaemonOrchestrator = (context: DaemonLaneContext) => Promise<void>;

/** Runs orchestration for one daemon-managed registry entry. The lane context resolves
 *  factory-state paths from the entry's external `stateRoot` (via createDaemonLaneContext
 *  / getFactoryPaths), falling back to the checkout's `.factory/` only when no stateRoot
 *  is registered, so the injected orchestrator never sees checkout-local paths for an
 *  externally-rooted repo. Returns the context it dispatched with. */
export async function runDaemonRepo(
  entry: RepoRegistryListing,
  orchestrate: DaemonOrchestrator,
): Promise<DaemonLaneContext> {
  const context = createDaemonLaneContext(entry);
  await orchestrate(context);
  return context;
}
