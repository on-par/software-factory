// packages/core/src/sim/regressions.ts — known production faults encoded as simulator
// fixtures (#567). Each fixture reproduces the *historical* signature of a fault that is
// still open; when the fault lands, flip the assertion in regressions.test.ts (and update
// the `historicalSignature` line here) rather than deleting the fixture.

import matter from 'gray-matter';

import { simDefaultScripts, simSpecContent, type SimIssueSpec } from './pipeline.js';

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
  const parsed = matter(simSpecContent(issue, title));
  const design = parsed.data.design as { interfacesTouched: unknown[] };
  design.interfacesTouched = [`feature-${issue}.txt`, { file: `feature-${issue}.txt`, symbol: `simFeature${issue}` }];
  return matter.stringify(parsed.content, parsed.data);
}

const FIXTURE_550_TITLE = 'Sim regression #550: fenced enrichment output';
const FIXTURE_551_TITLE = 'Sim regression #551: object element in interfacesTouched';

export const SIM_REGRESSION_FIXTURES: readonly SimRegressionFixture[] = [
  {
    fault: 550,
    name: 'fenced-enrichment-output-park',
    historicalSignature:
      'PLAN escalates with "enrichment output failed readiness" naming all five required ' +
      'fields as missing, after exactly one readiness_enrich call (no retry).',
    // Known harness gap (out of scope for #567): createSimOctokit has no issues.update, which
    // planPhase calls after a *successful* enrichment. Once #550 is fixed and this fixture is
    // flipped to assert a shipped run, that endpoint must be added to the fake octokit first.
    spec: {
      issue: 9550,
      title: FIXTURE_550_TITLE,
      body: INCOMPLETE_FACTORY_TASK_BODY,
      enforceReadiness: true,
      scripts: {
        ...simDefaultScripts(9550, FIXTURE_550_TITLE),
        readiness_enrich: [{ output: SIM_FENCED_ENRICHMENT_OUTPUT }],
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
];

export function simRegressionFixture(fault: number): SimRegressionFixture {
  const fixture = SIM_REGRESSION_FIXTURES.find((f) => f.fault === fault);
  if (!fixture) throw new Error(`no simulator regression fixture for fault #${fault}`);
  return fixture;
}
