import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as publicApi from './index.js';
import * as internalApi from './internal.js';
import * as testingApi from './testing.js';

// Pins the exact export surface of each @on-par/factory-core entry point
// (ADR-0004). Object.keys(...) only reflects runtime values — type-only
// exports (export type ...) don't appear at runtime, so these allowlists
// list value exports only.

const PUBLIC_API_KEYS = [
  // Config
  'getConstitutionsDir',
  'getFactoryPaths',
  'loadFactoryConfig',
  'loadModelsConfig',
  'loadRoutesConfig',
  'resolveSkipCI',
  'resolveTimeouts',
  // Queue
  'parseQueue',
  'readQueue',
  'validateQueue',
  // Events
  'followEvents',
  'readEvents',
  // Models
  'diagnoseModels',
  'isCommandAvailable',
  'ModelRegistry',
  'resolveModelOverrides',
  // Router
  'failoversFrom',
  'ModelRouter',
  // Harness contract
  'HARNESS_CATALOG',
  'HarnessError',
  'KNOWN_HARNESS_IDS',
  // Constitutions
  'buildConstitutionContext',
  'ConstitutionLoader',
  'REPO_INSTRUCTION_FILES',
  // Sandbox
  'detectSandboxRuntime',
  'resolveSandboxPolicy',
  // Checkers
  'accessibilityChecker',
  'compileChecker',
  'linksChecker',
  'lintChecker',
  'runAllCheckers',
  'runCustomChecker',
  'testsChecker',
  // Phases
  'buildPhase',
  'checkPhase',
  'planPhase',
  'shipPhase',
  // Approvals
  'createFileApprovalGate',
  'listPendingApprovals',
  'respondToApproval',
  // Steering
  'applySteering',
  'describeSteering',
  'drainSteering',
  'extractPathCandidates',
  'listQueuedSteering',
  'MAX_ATTACHMENT_BYTES',
  'queueSteeringMessage',
  'steeringFileFor',
  // Reports
  'renderLocalRunReport',
  'writeLocalRunReport',
  // Discovery
  'DEFAULT_MAX_CANDIDATES',
  'runDiscoveryScan',
  'authorDraftEpic',
  'DEFAULT_OWNER_QUESTIONS',
  'DISCOVERY_LABEL',
  'EXPLORING_LABEL',
  'ideaMarker',
  // Eval
  'appendHistoryLine',
  'buildLocalSmallScoreboard',
  'compareToBaseline',
  'formatRegressionIssue',
  'isRouteAsserted',
  'loadGoldenCases',
  'parseHistory',
  'REGRESSION_ISSUE_MARKER',
  'REGRESSION_ISSUE_TITLE',
  'renderLocalSmallScoreboardMarkdown',
  'renderTrend',
  'runEval',
  'summaryToHistoryRecord',
  'toBaseline',
  // Logger
  'createLogger',
  // Usage
  'aggregateCosts',
  'estimateTrailingSpend',
  'formatUsageReport',
  'readCostsFile',
  'readUsage',
  'watchUsage',
  'fetchSubscriptionUsage',
];

const INTERNAL_API_KEYS = [
  // Failure fingerprint & evidence
  'captureFailure',
  'fingerprintFailure',
  'normalizeFailureMessage',
  // Auto-file a fingerprinted bug (#373)
  'createOctokitFilingClient',
  'DEFAULT_BUG_LABELS',
  'DEFAULT_INTERNAL_REPO',
  'fileBug',
  'findMatchingIssue',
  'fingerprintMarker',
  'renderBugBody',
  'renderOccurrenceComment',
  'resolveTargetRepo',
  // Concrete coding harnesses
  'classifyFailure',
  'ClaudeCliHarness',
  'CodexCliHarness',
  'isAgenticHarness',
  'isRetryableFailure',
  'NON_RETRYABLE_FAILURE_REASONS',
  'OllamaAgenticHarness',
  'PATCH_PROPOSAL_SCHEMA',
  'OllamaHttpHarness',
  'OpenCodeHarness',
  // Router
  'CliModelExecutor',
  // Phase helpers
  'disputeResolution',
  'buildPlanPrompt',
  // Local-small harness
  'applyLocalSmallPatchStep',
  'createLocalSmallDryRun',
  'runOvernightQueue',
  // Eval internals
  'judgeSpec',
  'median',
  'runJudgeSamples',
  'scoreSpec',
  // Usage internals
  'defaultTranscriptRoots',
  'priceFor',
  'TRAILING_WINDOW_MS',
  'readClaudeAccessToken',
  // Utils
  'branchFor',
  'branchPrefixSlug',
  'cleanupWorktree',
  'codexDisabled',
  'colorEnabled',
  'ensureDir',
  'escalationLine',
  'formatEventLine',
  'gitFetch',
  'isEscalation',
  'levelForType',
  'logCost',
  'logEvent',
  'readCosts',
  'setupWorktree',
  'shellEscape',
  'slugify',
  'watchChecks',
  'describeCommandFailure',
  'runCommand',
  'withFileLock',
  'withGitLock',
  'findCredentialFiles',
  'formatGcReport',
  'parseWorktreeList',
  'scrubFile',
  'sweepWorktrees',
  'zeroFill',
  'checkRatchetDrift',
  'checkScopedRatchetDrift',
  'DEFAULT_RATCHET_SLACK',
  'parseCoverageSummary',
  'parseCoverageSummaryScopes',
  'renderRatchetReport',
];

const TESTING_API_KEYS = [
  'StubModelExecutor',
  'StubCodingHarness',
  'codingHarnessContractCases',
  'makeContractRequest',
  'loadInjectionFixtures',
];

describe('public API surface (ADR-0004)', () => {
  it('root export exposes exactly the documented public API', () => {
    expect(Object.keys(publicApi).sort()).toEqual([...PUBLIC_API_KEYS].sort());
  });

  it('root export has no internal or testing symbols', () => {
    for (const key of [
      'ClaudeCliHarness',
      'CodexCliHarness',
      'StubModelExecutor',
      'StubCodingHarness',
      'codingHarnessContractCases',
      'shellEscape',
      'withGitLock',
      'buildPlanPrompt',
      'createLocalSmallDryRun',
      'judgeSpec',
    ]) {
      expect(Object.keys(publicApi)).not.toContain(key);
    }
  });

  it('./internal exposes exactly the documented internal API', () => {
    expect(Object.keys(internalApi).sort()).toEqual([...INTERNAL_API_KEYS].sort());
  });

  it('./testing exposes exactly the documented testing API', () => {
    expect(Object.keys(testingApi).sort()).toEqual([...TESTING_API_KEYS].sort());
  });

  it('package.json declares exactly the three documented entry points', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      exports: Record<string, { development: string; import: string; types: string }>;
    };
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './internal', './testing'].sort());
    for (const entry of Object.values(pkg.exports)) {
      expect(Object.keys(entry).sort()).toEqual(['development', 'import', 'types']);
    }
  });
});
