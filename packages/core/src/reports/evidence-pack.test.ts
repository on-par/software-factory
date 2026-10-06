import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { renderDesignArtifact } from '../design/index.js';
import type { CheckSummary, FactoryEvent } from '../types/index.js';
import { gatherEvidencePack, renderEvidencePack } from './evidence-pack.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function mkdtemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-evidence-pack-'));
  tempDirs.push(dir);
  return dir;
}

const checkSummary: CheckSummary = {
  failures: 1,
  passes: 1,
  skips: 1,
  total: 3,
  results: [
    { checker: 'compile', result: 'PASS', details: 'build succeeded' },
    { checker: 'tests', result: 'FAIL', details: 'x'.repeat(300) },
    { checker: 'links', result: 'SKIP', details: 'no links checker configured' },
  ],
};

const events: FactoryEvent[] = [
  { ts: '2026-07-20T10:00:00Z', type: 'rework', issue: '385', msg: 'sending back to worker (round 1)' },
  { ts: '2026-07-20T10:05:00Z', type: 'check', issue: '385', msg: 'all checkers passed' },
  { ts: '2026-07-20T10:06:00Z', type: 'ship', issue: '385', msg: 'Starting ship phase' },
];

describe('renderEvidencePack', () => {
  it('renders a full pack with checker verdicts, rework, and logs', () => {
    const markdown = renderEvidencePack({
      issue: 385,
      checkSummary,
      reworkRounds: 2,
      events,
      logFiles: ['issue-385.build.log', 'issue-385.check.log'],
    });

    expect(markdown).toContain('## 🔎 Evidence pack');
    expect(markdown).toContain('Checkers: 1 pass, 1 fail, 1 skip');
    expect(markdown).toContain('Rework rounds: 2');
    expect(markdown).toContain('✅ PASS `compile`');
    expect(markdown).toContain('❌ FAIL `tests`');
    expect(markdown).toContain('⚪ SKIP `links`');
    for (const event of events) {
      expect(markdown).toContain(`${event.type}: ${event.msg}`);
    }
    expect(markdown).toContain('issue-385.build.log');
    expect(markdown).toContain('issue-385.check.log');
    expect(markdown.match(/<details>/g)?.length).toBe(4);
    expect(markdown.match(/<\/details>/g)?.length).toBe(4);
  });

  it('truncates long checker details to ~200 characters', () => {
    const markdown = renderEvidencePack({
      issue: 385,
      checkSummary,
      events: [],
      logFiles: [],
    });
    const failLine = markdown.split('\n').find((line) => line.includes('FAIL `tests`'));
    expect(failLine).toBeDefined();
    expect(failLine!.length).toBeLessThan(250);
    expect(failLine).toContain('…');
  });

  it('falls back cleanly when checkSummary, events, and logFiles are all absent', () => {
    const markdown = renderEvidencePack({
      issue: 385,
      events: [],
      logFiles: [],
    });

    expect(markdown).toContain('## 🔎 Evidence pack');
    expect(markdown).toContain('No verification data available.');
    expect(markdown).toContain('No checker results recorded.');
    expect(markdown).toContain('- No per-issue log files found.');
    expect(markdown).not.toContain('Frozen spec');
    expect(markdown).not.toContain('Event timeline');
    expect(markdown.length).toBeGreaterThan(0);
  });

  it('preserves rework rounds and shows a final passed verdict when failures are zero (AC-2)', () => {
    const markdown = renderEvidencePack({
      issue: 385,
      checkSummary: { failures: 0, passes: 3, skips: 0, total: 3, results: [] },
      reworkRounds: 1,
      events,
      logFiles: [],
    });

    expect(markdown).toContain('Rework rounds: 1');
    expect(markdown).toContain('rework: sending back to worker (round 1)');
    expect(markdown).toContain('Final result: all checkers passed');
  });

  it('shows the remaining failure count in the final verdict when failures are non-zero', () => {
    const markdown = renderEvidencePack({
      issue: 385,
      checkSummary,
      events: [],
      logFiles: [],
    });

    expect(markdown).toContain('Final result: 1 failure(s) remain');
  });

  it('includes designMarkdown in the Design artifact section when provided (#422)', () => {
    const markdown = renderEvidencePack({
      issue: 422,
      events: [],
      logFiles: [],
      designMarkdown: '## Design artifact (#422)\n\nRestated problem here.',
    });

    expect(markdown).toContain('Design artifact');
    expect(markdown).toContain('- Design artifact has no Behavior contract or Verification plan.');
    expect(markdown).not.toContain('Restated problem here.');
  });

  it('falls back when designMarkdown is an empty string', () => {
    const markdown = renderEvidencePack({ issue: 422, events: [], logFiles: [], designMarkdown: '' });

    expect(markdown).toContain('- Design artifact has no Behavior contract or Verification plan.');
  });

  it('never renders a Frozen spec section (#2249)', () => {
    const markdown = renderEvidencePack({ issue: 1, checkSummary, reworkRounds: 1, events, logFiles: [] });

    expect(markdown).not.toContain('Frozen spec');
  });

  it('falls back to "No design artifact recorded." when designMarkdown is absent (#422)', () => {
    const markdown = renderEvidencePack({ issue: 422, events: [], logFiles: [] });

    expect(markdown).toContain('- No design artifact recorded.');
  });
});

describe('renderEvidencePack — review routing (#1724)', () => {
  const base = { issue: 1, events: [], logFiles: [] };

  it('has no Review routing section when no routing is given', () => {
    expect(renderEvidencePack(base)).not.toContain('Review routing');
  });

  it('lists the floor, gate reason and each fired rule with its paths', () => {
    const md = renderEvidencePack({
      ...base,
      reviewRouting: {
        floor: 'C',
        gated: true,
        reason: 'classifier:floor:C:workflows',
        rules: [
          { id: 'workflows', class: 'C', paths: ['.github/workflows/ci.yml', 'b.yml'] },
          { id: 'empty-diff', class: 'B', paths: [] },
        ],
      },
    });
    expect(md).toContain('Review routing');
    expect(md).toContain('- Floor: **C**');
    expect(md).toContain('- Gate: held for a human — `classifier:floor:C:workflows`');
    expect(md).toContain('- `workflows` (C): `.github/workflows/ci.yml`, `b.yml`');
    expect(md).toContain('- `empty-diff` (B): (no paths)');
  });

  it('renders an A floor as auto-merge eligible with no rules', () => {
    const md = renderEvidencePack({ ...base, reviewRouting: { floor: 'A', gated: false, rules: [] } });
    expect(md).toContain('- Floor: **A**');
    expect(md).toContain('- Gate: none — auto-merge eligible');
    expect(md).toContain('- No rules fired.');
  });

  it('renders a classifier error as unavailable', () => {
    const md = renderEvidencePack({
      ...base,
      reviewRouting: { floor: null, gated: true, reason: 'classifier:error', error: 'boom', rules: [] },
    });
    expect(md).toContain('- Floor: unavailable (classifier error: boom)');
    expect(md).toContain('`classifier:error`');
  });
});

describe('renderEvidencePack — shadow model verdict (#1725)', () => {
  const base = { issue: 1, events: [], logFiles: [] };
  const shadow = {
    modelClass: 'C' as const,
    floorClass: 'A' as const,
    finalClass: 'A' as const,
    model: 'm-1',
    promptVersion: 'classify-pr/v1',
    policyVersion: 'floor-0123456789ab',
    diffSha: 'f'.repeat(64),
    adrIds: ['ADR-0121', 'ADR-0123'],
    costUsd: null,
    claims: [{ text: 'touches the gate', citation: 'src/a.ts:12' }],
    unsupportedClaims: [{ text: 'vibes', citation: '' }],
    notInspected: ['tests'],
    droppedClaims: 0,
  };

  it('renders the labeled shadow block with class, claims, gaps and ADRs', () => {
    const md = renderEvidencePack({
      ...base,
      reviewRouting: { floor: 'A', gated: false, rules: [], shadow },
    });
    expect(md).toContain('Shadow model verdict — shadow — no effect');
    expect(md).toContain('Model class: **C** (`m-1`, `classify-pr/v1`, policy `floor-0123456789ab`)');
    expect(md).toContain('Final class: A (= floor)');
    expect(md).toContain('touches the gate — `src/a.ts:12`');
    expect(md).toContain('- vibes');
    expect(md).toContain('- tests');
    expect(md).toContain('ADRs consulted: ADR-0121, ADR-0123');
  });

  it('renders the reason and "none" when the model verdict is unavailable', () => {
    const md = renderEvidencePack({
      ...base,
      reviewRouting: {
        floor: 'A',
        gated: false,
        rules: [],
        shadow: {
          ...shadow,
          modelClass: null,
          reason: 'classifier call failed: x',
          claims: [],
          unsupportedClaims: [],
          notInspected: [],
          adrIds: [],
        },
      },
    });
    expect(md).toContain('Model class: unavailable — classifier call failed: x');
    expect(md).toContain('ADRs consulted: none');
    expect(md).toContain('  - none');
  });

  it('renders no shadow block without a shadow verdict', () => {
    const md = renderEvidencePack({ ...base, reviewRouting: { floor: 'A', gated: false, rules: [] } });
    expect(md).not.toContain('Shadow model verdict');
  });
});

describe('gatherEvidencePack', () => {
  it('reads a spec file, extracts the Goal section, filters events, and lists matching log files', () => {
    const dir = mkdtemp();
    const specPath = join(dir, 'issue-7.md');
    writeFileSync(
      specPath,
      [
        '---',
        'route: codex',
        '---',
        '# Spec: something (#7)',
        '',
        '## Goal',
        'Make the widget spin faster than before.',
        '',
        '## Files',
        'not part of the goal',
        '',
      ].join('\n'),
    );

    const eventsFile = join(dir, 'events.ndjson');
    writeFileSync(
      eventsFile,
      [
        JSON.stringify({ ts: '2026-07-20T09:00:00Z', type: 'plan', issue: '7', msg: 'planning' }),
        JSON.stringify({ ts: '2026-07-20T09:05:00Z', type: 'check', issue: '7', msg: 'checked' }),
        JSON.stringify({ ts: '2026-07-20T09:06:00Z', type: 'plan', issue: '9', msg: 'other issue' }),
      ].join('\n'),
    );

    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir);
    writeFileSync(join(logsDir, 'issue-7.build.log'), 'log contents');
    writeFileSync(join(logsDir, 'issue-70.build.log'), 'unrelated issue');
    writeFileSync(join(logsDir, 'other.log'), 'unrelated file');

    const markdown = gatherEvidencePack({
      issue: 7,
      specPath,
      eventsFile,
      startedAt: '2026-07-20T08:00:00Z',
      logsDir,
    });

    expect(markdown).not.toContain('Make the widget spin faster than before.');
    expect(markdown).not.toContain('not part of the goal');
    expect(markdown).toContain('check: checked');
    expect(markdown).not.toContain('other issue');
    expect(markdown).toContain('issue-7.build.log');
    expect(markdown).not.toContain('issue-70.build.log');
    expect(markdown).not.toContain('other.log');
  });

  it('falls back cleanly with no throw when all optional paths are omitted', () => {
    expect(() => gatherEvidencePack({ issue: 385 })).not.toThrow();
    const markdown = gatherEvidencePack({ issue: 385 });
    expect(markdown).toContain('## 🔎 Evidence pack');
    expect(markdown).not.toContain('Frozen spec');
  });

  it('does not render the spec body when the spec has no Goal section', () => {
    const dir = mkdtemp();
    const specPath = join(dir, 'issue-8.md');
    writeFileSync(specPath, '# Spec: no goal section\n\nJust some body text describing the change.\n');

    const markdown = gatherEvidencePack({ issue: 8, specPath });

    expect(markdown).not.toContain('Just some body text describing the change.');
  });

  it('picks up a .design.md on disk beside the spec (#422)', () => {
    const dir = mkdtemp();
    const specPath = join(dir, 'issue-422.md');
    writeFileSync(specPath, '---\nroute: codex\n---\n# Spec\n');
    writeFileSync(
      join(dir, 'issue-422.design.md'),
      [
        '## Design artifact (#422)',
        '',
        '### Restated problem',
        '',
        'Restated problem text.',
        '',
        '### Behavior contract',
        '',
        '- Contract text.',
        '',
        '### Verification plan',
        '',
        '- Plan text.',
        '',
      ].join('\n'),
    );

    const markdown = gatherEvidencePack({ issue: 422, specPath });

    expect(markdown).toContain('Contract text.');
    expect(markdown).toContain('Plan text.');
    expect(markdown).not.toContain('Restated problem text.');
  });

  it('falls back to "No design artifact recorded." when no .design.md exists (#422)', () => {
    const dir = mkdtemp();
    const specPath = join(dir, 'issue-423.md');
    writeFileSync(specPath, '---\nroute: codex\n---\n# Spec\n');

    const markdown = gatherEvidencePack({ issue: 423, specPath });

    expect(markdown).toContain('- No design artifact recorded.');
  });
});

describe('renderEvidencePack — regression_hunt (#1839)', () => {
  const render = (results: CheckSummary['results'], counts: Partial<CheckSummary>) =>
    renderEvidencePack({
      checkSummary: { failures: 0, passes: 0, skips: 0, total: results.length, results, ...counts },
      issue: 1839,
      events: [],
      logFiles: [],
    });

  it('shows nested findings in full for a FAIL', () => {
    const out = render(
      [
        {
          checker: 'regression_hunt',
          result: 'FAIL',
          details: 'regressed',
          findings: [
            {
              input: 'npm-shrinkwrap.json only',
              before: 'ok-before',
              after: 'bad-after',
              evidence: 'e',
              reproduced: true,
            },
          ],
        },
      ],
      { failures: 1 },
    );
    expect(out).toContain('`regression_hunt`');
    expect(out).toMatch(/ {2}- input: npm-shrinkwrap\.json only .*before: ok-before.*after: bad-after.*reproduced/);
  });

  it('shows an explicit no-findings bullet for a PASS', () => {
    const out = render([{ checker: 'regression_hunt', result: 'PASS', details: 'clean', findings: [] }], { passes: 1 });
    expect(out).toContain('  - no findings');
  });

  it('shows a SKIP as a skip with its reason', () => {
    const out = render(
      [{ checker: 'regression_hunt', result: 'SKIP', details: 'review floor class A — regression hunt not run' }],
      { skips: 1 },
    );
    expect(out).toContain('⚪ SKIP `regression_hunt` — review floor class A');
    expect(out).not.toContain('PASS `regression_hunt`');
    expect(out).toContain('0 pass, 0 fail, 1 skip');
    expect(out).not.toContain('  - ');
  });
});

describe('renderEvidencePack — design trim (#2249)', () => {
  const artifact = {
    restatedProblem: 'RESTATED-X',
    approach: { chosen: 'APPROACH-X', rejected: [{ option: 'REJ-OPT-X', reason: 'REJ-WHY-X' }] },
    interfacesTouched: ['IFACE-X'],
    targetTypes: [{ name: 'TargetX', file: 'a.ts', kind: 'changed' as const }],
    signatures: [{ symbol: 'symX', file: 'a.ts', signature: 'sigX()' }],
    callGraph: [{ from: 'CALL-FROM-X', to: 'CALL-TO-X' }],
    behaviorContract: ['BEHAVIOR-X'],
    verificationPlan: [{ command: 'cmd-x', passWhen: 'PASSWHEN-X' }],
    riskBlastRadius: 'RISK-X',
    openQuestions: ['OPENQ-X'],
  } as Parameters<typeof renderDesignArtifact>[0];
  const render = (designMarkdown: string) => renderEvidencePack({ issue: 7, events: [], logFiles: [], designMarkdown });

  it('keeps only the Behavior contract and Verification plan, in order', () => {
    const md = render(renderDesignArtifact(artifact, 7));

    expect(md).toContain('### Behavior contract');
    expect(md).toContain('- BEHAVIOR-X');
    expect(md).toContain('### Verification plan');
    expect(md).toContain('- `cmd-x` — pass when: PASSWHEN-X');
    expect(md.indexOf('### Behavior contract')).toBeLessThan(md.indexOf('### Verification plan'));
    for (const heading of [
      'Restated problem',
      'Approach',
      'Interfaces touched',
      'Target types',
      'Key signatures',
      'Call graph',
      'Risk / blast radius',
      'Open questions',
    ]) {
      expect(md).not.toContain(`### ${heading}`);
    }
    for (const text of ['RESTATED-X', 'APPROACH-X', 'IFACE-X', 'CALL-FROM-X', 'RISK-X', 'OPENQ-X']) {
      expect(md).not.toContain(text);
    }
  });

  it('keeps only the subsection that is present', () => {
    const md = render(
      '## Design artifact (#7)\n\n### Approach\n\nAPPROACH-X\n\n### Behavior contract\n\n- ONLY-X\n\n### Risk\n\nRISK-X',
    );

    expect(md).toContain('- ONLY-X');
    expect(md).not.toContain('### Verification plan');
    expect(md).not.toContain('APPROACH-X');
    expect(md).not.toContain('RISK-X');
  });

  it('captures a last-in-document subsection to the end of the string', () => {
    const md = render('## Design artifact (#7)\n\n### Verification plan\n\n- LAST-A\n- LAST-B\n');

    expect(md).toContain('### Verification plan\n\n- LAST-A\n- LAST-B');
  });
});

describe('renderEvidencePack — PR #2162 fixture (#2249)', () => {
  const before = readFileSync(
    new URL('../__fixtures__/evidence-pack-2162/comment-before.md', import.meta.url),
    'utf-8',
  );
  const checkers = [
    ['worker_output', 'worker produced a diff against origin/main'],
    ['compile', 'npm run build: OK'],
    ['tests', 'scripts/verify.sh: OK'],
    ['lint', 'lint: OK; tsc: OK'],
    ['links', 'checked 4 links, all OK'],
    ['accessibility', 'basic checks passed (alt, placeholder links) — scanned 2 HTML files'],
    ['design_smells', 'no program-design smells found in the diff'],
  ] as const;
  const designMarkdown = before.split('<summary>Design artifact</summary>')[1]!.split('</details>')[0]!.trim();
  const timeline = before.split('<summary>Event timeline</summary>')[1]!.split('</details>')[0]!;
  const fixtureEvents: FactoryEvent[] = timeline
    .split('\n')
    .map((line) => line.match(/^- (\S+) ([^:]+): (.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ ts: m[1]!, type: m[2]! as FactoryEvent['type'], issue: '2149', msg: m[3]! }));

  it('renders in under half the original line count and keeps verdicts and rework', () => {
    const rendered = renderEvidencePack({
      issue: 2149,
      checkSummary: {
        failures: 0,
        passes: checkers.length,
        skips: 0,
        total: checkers.length,
        results: checkers.map(([checker, details]) => ({ checker, result: 'PASS' as const, details })),
      },
      reworkRounds: 0,
      designMarkdown,
      events: fixtureEvents,
      logFiles: [],
    });

    expect(fixtureEvents.length).toBeGreaterThan(0);
    expect(rendered.split('\n').length).toBeLessThan(before.split('\n').length / 2);
    expect(rendered).toContain('Checker verdicts');
    for (const [checker] of checkers) expect(rendered).toContain(`✅ PASS \`${checker}\``);
    expect(rendered).toContain('Rework & verification');
    expect(rendered).toContain('- Rework rounds: 0');
    expect(rendered).toContain('- Final result: all checkers passed');
    expect(rendered).not.toContain('Frozen spec');
    expect(rendered).not.toContain('### Restated problem');
    expect(rendered).not.toContain('Event timeline');
  });
});
