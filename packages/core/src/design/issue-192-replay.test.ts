import { describe, expect, it } from 'vitest';
import { findUnresolvedRegressions, parseDesignArtifact } from './index.js';

// Never-retire replay of issue #192: install detection knew package-lock.json only, so a
// shrinkwrap-only repo silently fell through to the no-lockfile branch.
const SHRINKWRAP_INPUT = 'repo with only npm-shrinkwrap.json';

const compliant192 = {
  design: {
    restatedProblem: 'Pick the npm install command from the lockfile the repo carries.',
    approach: {
      chosen: 'Use npm ci when a lockfile exists, else npm install.',
      rejected: [{ option: 'Always npm install', reason: 'Ignores the lockfile.' }],
    },
    interfacesTouched: ['install command detection'],
    behaviorContract: ['A repo with an npm lockfile installs with npm ci.'],
    verificationPlan: [{ command: 'npm run test', passWhen: 'install detection tests pass' }],
    riskBlastRadius: 'Wrong install command for npm repos.',
    openQuestions: [`Should a ${SHRINKWRAP_INPUT} use npm ci instead of falling through to npm install?`],
    edgeInputs: ['npm with package-lock.json', 'npm without a lockfile', SHRINKWRAP_INPUT],
    behaviorDelta: [
      {
        input: 'npm with package-lock.json',
        branch: 'lockfile present',
        before: 'npm install',
        after: 'npm ci',
        verdict: 'better',
      },
      {
        input: 'npm without a lockfile',
        branch: 'no lockfile',
        before: 'npm install',
        after: 'npm install',
        verdict: 'same',
      },
      {
        input: SHRINKWRAP_INPUT,
        branch: 'no lockfile (fallthrough)',
        before: 'npm install',
        after: 'npm install, shrinkwrap ignored',
        verdict: 'worse',
      },
    ],
    externalLists: [
      {
        name: 'npm lockfile names',
        location: 'install command detection',
        source: 'https://docs.npmjs.com/cli/configuring-npm/npm-shrinkwrap-json',
        gaps: ['npm-shrinkwrap.json'],
      },
    ],
  },
};

// Same artifact with the fallthrough row left unresolved: nothing in openQuestions names it.
const nonCompliant192 = { design: { ...compliant192.design, openQuestions: [] } };

function parse(frontmatter: unknown) {
  const { artifact, errors } = parseDesignArtifact(frontmatter);
  if (!artifact) throw new Error(errors.join('; '));
  return artifact;
}

describe('issue #192 replay fixture (#1820)', () => {
  it('validates and records the shrinkwrap-only fallthrough on the no-lockfile branch', () => {
    const { artifact, errors } = parseDesignArtifact(compliant192);
    expect(errors).toEqual([]);
    expect(artifact).not.toBeNull();
    const rows = artifact?.behaviorDelta ?? [];
    const row = rows.find((r) => r.input === SHRINKWRAP_INPUT);
    expect(row).toBeDefined();
    expect(row?.branch).toContain('no lockfile');
    expect(rows.some((r) => r.input === 'npm with package-lock.json')).toBe(true);
    expect(rows.some((r) => r.input === 'npm without a lockfile')).toBe(true);
  });

  it('lists lockfile names with a cited source and the npm-shrinkwrap.json gap', () => {
    const list = parse(compliant192).externalLists?.find((l) => l.name.toLowerCase().includes('lockfile'));
    expect(list).toBeDefined();
    expect(list?.source).toMatch(/^https?:\/\//);
    expect(list?.gaps).toContain('npm-shrinkwrap.json');
  });

  it('compliant artifact has no unresolved regressions', () => {
    expect(findUnresolvedRegressions(parse(compliant192))).toEqual([]);
  });

  it('non-compliant artifact surfaces the shrinkwrap row as unresolved', () => {
    const rows = findUnresolvedRegressions(parse(nonCompliant192));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.input).toBe(SHRINKWRAP_INPUT);
  });
});
