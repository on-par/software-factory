// The checker surface re-exported from @on-par/factory-core/internal.

export { listBuiltInCheckers } from './index.js';
export { describeChecksProbe, resolveCompileCommand, resolveLintCommands, resolveTestsCommand } from './index.js';
// The source-checkout config snapshot every CHECK resolver reads in a one-shot run (#3600).
export { holdRunConfigSnapshot, lastRunConfigLadder } from '../config/run-config-source.js';
export {
  describeConfigSources,
  resolveConstitutionOverride,
  type RunConfigLadder,
} from '../config/run-config-ladder.js';
export {
  buildDetectChecksPrompt,
  CHECK_KINDS,
  detectCheckHeuristics,
  heuristicProposal,
  parseDetectedChecks,
  type CheckProposal,
} from './detect-checks.js';
export { tokenizeEvidenceCommand } from './evidence-allowlist.js';
export { resolveWorkspaceTestRunners } from './evidence-workspace.js';
// CHECK command output export: verification runner and OTLP session flush on exit and signals (#3996).
export { runVerificationCommand } from './run-command.js';
export {
  flushCommandOutputExports,
  withCommandOutputExport,
  type CommandOutputFlushReport,
} from '../command-output/otlp-export.js';
// UI visual proof gate land check (#2232).
export { assertVisualProofForHead, VisualProofMissingError } from './visual-proof-attach.js';
