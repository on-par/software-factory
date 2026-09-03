// packages/core/src/sim/regressions.ts — known production faults encoded as simulator
// fixtures (#567). Each fixture reproduces the *historical* signature of a fault that is
// still open; when the fault lands, flip the assertion in regressions.test.ts (and update
// the `historicalSignature` line here) rather than deleting the fixture.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseSpec, stringifySpec } from '../spec/index.js';
import type { SimModelStep } from './model.js';
import { simDefaultScripts, simSpecContent, type SimIssueSpec } from './pipeline.js';
import { simCommitAll } from './workspace.js';

export interface SimRegressionFixture {
  /** GitHub issue number of the production fault this fixture encodes. */
  fault: number;
  /** Short slug naming the fault. */
  name: string;
  /** The historical (pre-fix) behaviour the simulator reproduces for this fixture. */
  historicalSignature: string;
  /** The simulator input that reproduces it. */
  spec: SimIssueSpec;
}

/** A factory-task body missing four of the five required fields — forces enrichment. */
const INCOMPLETE_FACTORY_TASK_BODY = '## Problem statement\nThe importer stalls on large files.\n';

const COMPLETE_FACTORY_TASK_BODY = [
  '## Problem statement',
  'The importer stalls on large files.',
  '',
  '## In scope',
  'Repair the importer queue.',
  '',
  '## Out of scope',
  'Changing the queue API.',
  '',
  '## Acceptance criteria',
  '- [ ] Large files import without stalling.',
  '',
  '## Verification',
  'npm run test',
].join('\n');

/** #550: otherwise-valid Markdown wrapped in a whole-output code fence. `extractIssueSections`
 *  swallows every heading inside the fence, so the scorer sees zero sections. */
export const SIM_FENCED_ENRICHMENT_OUTPUT = '```markdown\n' + COMPLETE_FACTORY_TASK_BODY + '\n```';

/** #551: the frozen PLAN spec, but with one object-shaped element in `interfacesTouched` —
 *  the shape a model emits when it mirrors the sibling object lists in the PLAN prompt. */
export function simSpecWithObjectInterface(issue: number, title: string): string {
  const parsed = parseSpec(simSpecContent(issue, title));
  const design = parsed.data.design as { interfacesTouched: unknown[] };
  design.interfacesTouched = [`feature-${issue}.txt`, { file: `feature-${issue}.txt`, symbol: `simFeature${issue}` }];
  return stringifySpec(parsed.body, parsed.data);
}

const FIXTURE_550_TITLE = 'Sim regression #550: fenced enrichment output';
const FIXTURE_551_TITLE = 'Sim regression #551: object element in interfacesTouched';
const FIXTURE_1222_TITLE = 'Sim regression #1222: uncommitted build output after green check';

/** #1222: BUILD commits its feature file but leaves an extra file uncommitted — the
 *  factory's own build output after a green CHECK. Drives the real shipPhase against a
 *  real worktree so commitLeftoverBuildOutput (#1172) must commit it and ship. */
const FIXTURE_1222_BUILD_STEP: SimModelStep = {
  output: 'built',
  effect: async (ctx) => {
    await writeFile(join(ctx.worktree, 'feature-9553.txt'), 'simulated build for issue #9553\n');
    await simCommitAll(ctx.worktree, 'feat: sim issue 9553');
    await writeFile(join(ctx.worktree, 'build-output-9553.txt'), 'uncommitted build output after check\n');
  },
};

export const SIM_REGRESSION_FIXTURES: readonly SimRegressionFixture[] = [
  {
    fault: 550,
    name: 'fenced-enrichment-output-park',
    historicalSignature:
      '(fixed by #816) PLAN used to escalate after exactly one readiness_enrich call; it now retries with the missing headings named and the run ships.',
    spec: {
      issue: 9550,
      title: FIXTURE_550_TITLE,
      body: INCOMPLETE_FACTORY_TASK_BODY,
      enforceReadiness: true,
      scripts: {
        ...simDefaultScripts(9550, FIXTURE_550_TITLE),
        readiness_enrich: [{ output: SIM_FENCED_ENRICHMENT_OUTPUT }, { output: COMPLETE_FACTORY_TASK_BODY }],
      },
    },
  },
  {
    fault: 551,
    name: 'object-element-in-interfaces-touched',
    historicalSignature:
      'PLAN returns designArtifact === null and logs design_artifact_invalid, yet the lane ships — ' +
      'the whole artifact is discarded silently.',
    spec: {
      issue: 9551,
      title: FIXTURE_551_TITLE,
      scripts: {
        ...simDefaultScripts(9551, FIXTURE_551_TITLE),
        plan: [{ output: simSpecWithObjectInterface(9551, FIXTURE_551_TITLE) }],
      },
    },
  },
  {
    fault: 1222,
    name: 'ship-parks-on-uncommitted-build-output',
    historicalSignature:
      '(fixed by #1172; re-pinned by #1222 after a stale-build ops regression) SHIP used to park the lane ' +
      'with "not recovering <branch>: worktree has uncommitted changes" even though CHECK had just verified ' +
      'that exact working tree; it now commits the leftover build output on the ship-it branch and ships.',
    spec: {
      issue: 9553,
      title: FIXTURE_1222_TITLE,
      scripts: {
        ...simDefaultScripts(9553, FIXTURE_1222_TITLE),
        build_claude: [FIXTURE_1222_BUILD_STEP],
        build_codex: [FIXTURE_1222_BUILD_STEP],
      },
    },
  },
];

export function simRegressionFixture(fault: number): SimRegressionFixture {
  const fixture = SIM_REGRESSION_FIXTURES.find((f) => f.fault === fault);
  if (!fixture) throw new Error(`no simulator regression fixture for fault #${fault}`);
  return fixture;
}
