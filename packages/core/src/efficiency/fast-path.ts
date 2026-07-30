import type { DesignArtifact } from '../types/index.js';

export interface FastPathInput {
  issue: number;
  title: string;
  issueBody: string;
}

export interface FastPathSpec {
  frontmatter: { route: 'codex'; design: DesignArtifact };
  markdown: string;
}

/** A deliberately narrow gate. Anything architectural, ambiguous, or missing a
 * complete factory-task brief still goes through the boss PLAN phase. */
export function isFastPathEligible(opts: { issueBody: string; readinessPassed: boolean }): boolean {
  if (!opts.readinessPassed || opts.issueBody.length > 12_000) return false;
  const text = opts.issueBody.toLowerCase();
  return (
    /##\s+(acceptance criteria|acceptance)/.test(text) &&
    /##\s+(in scope|scope|files|implementation)/.test(text) &&
    !/##\s+(architecture|open questions|design decision)/.test(text)
  );
}

/** Freeze the issue itself as the compact spec. The worker receives the exact
 * acceptance criteria and scope, without paying for exploratory planning. */
export function buildFastPathSpec(input: FastPathInput): FastPathSpec {
  const design: DesignArtifact = {
    restatedProblem: input.title,
    approach: {
      chosen: 'Implement the explicitly scoped acceptance criteria with the smallest safe change.',
      rejected: [{ option: 'Full exploratory plan', reason: 'The issue is complete, bounded, and mechanical.' }],
    },
    interfacesTouched: [],
    targetTypes: [],
    signatures: [],
    callGraph: [],
    behaviorContract: ['All acceptance criteria in the frozen issue body hold after the change.'],
    verificationPlan: [{ command: 'npm test', passWhen: 'the relevant test suite passes' }],
    riskBlastRadius: 'Bounded to the files named in the issue scope.',
    openQuestions: [],
  };
  return {
    frontmatter: { route: 'codex', design },
    markdown: `# Spec: ${input.title} (#${input.issue})\n\nThis is a compact, deterministic PLAN artifact. Implement only the issue body below.\n\n${input.issueBody.trim()}\n`,
  };
}
