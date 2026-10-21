// packages/grade/src/index.ts — public API of @on-par/factory-grade.
export { loadRuns } from './load-runs.js';
export type { LoadRunsOptions, LoadRunsResult } from './load-runs.js';
export {
  FAILURE_MODE_KINDS,
  GRADE_REPORT_SCHEMA_VERSION,
  gradeReportSchema,
  validateGradeReport,
} from './report-schema.js';
export type { FailureModeKind, GradeReport, GradeReportValidation } from './report-schema.js';
