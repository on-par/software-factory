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
export {
  summarizeCommandRun,
  parseCommandCounts,
  type CommandRunCounts,
  type SummarizeCommandRunOptions,
} from './command-output.js';
