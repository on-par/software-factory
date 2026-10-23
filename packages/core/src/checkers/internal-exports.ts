// The checker surface re-exported from @on-par/factory-core/internal.

export { listBuiltInCheckers, type BuiltInCheckerInfo } from './index.js';
export {
  resolveCompileCommand,
  resolveLintCommands,
  resolveTestsCommand,
  type CompileCommand,
  type LintCommand,
  type TestsCommand,
} from './index.js';
export { type ChecksConfigSource } from './index.js';
export {
  buildDetectChecksPrompt,
  CHECK_KINDS,
  detectCheckHeuristics,
  heuristicProposal,
  parseDetectedChecks,
  type CheckHeuristics,
  type CheckProposal,
  type DetectedChecks,
} from './detect-checks.js';
export { tokenizeEvidenceCommand } from './evidence-allowlist.js';
