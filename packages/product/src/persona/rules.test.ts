// packages/product/src/persona/rules.test.ts (#473).

import type { Epic, Story } from '@on-par/contracts';
import { CONTRACTS_SCHEMA_VERSION } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import type { IntentDoc, IntentStatement } from '../intent/index.js';
import type { PanelContext } from './findings.js';
import {
  customerAdoptionRule,
  customerMeasurableValueRule,
  engAutomatedVerificationRule,
  engRepoContextRule,
  mentions,
  opsObservabilityRule,
  opsRollbackRule,
  securityAbuseCaseRule,
  securityAuthorizationRule,
  storyText,
  supportFailurePathRule,
  supportRunbookRule,
} from './rules.js';

/** Neutral defaults: no cue from any rule's cue list appears anywhere in this story's text. */
function story(overrides: Partial<Story> = {}): Story {
  return {
    schemaVersion: CONTRACTS_SCHEMA_VERSION,
    kind: 'story',
    title: 'Ship the widget',
    role: 'widget user',
    want: 'the widget',
    soThat: 'the widget works',
    problemStatement: 'The widget is missing',
    inScope: ['ship the widget'],
    outOfScope: ['polish'],
    acceptanceCriteria: [
      {
        name: 'Widget works',
        given: ['a widget user'],
        when: ['they use the widget'],
        then: ['the widget works'],
        tracesTo: [],
      },
    ],
    verification: [{ command: 'npm run test:widget', passWhen: 'the widget works' }],
    filesLikelyTouched: ['src/widget.ts'],
    labels: [],
    tracesTo: [],
    ...overrides,
  };
}

const MINIMAL_DOC: IntentDoc = { brainDump: '', statements: [], gaps: [], status: 'approved' };

function docWithConstraint(text: string): IntentDoc {
  const statement: IntentStatement = { id: 'INT-CONSTRAINTS-01', dimension: 'constraints', text, source: 'answer' };
  return { ...MINIMAL_DOC, statements: [statement] };
}

const EPIC: Epic = {
  schemaVersion: CONTRACTS_SCHEMA_VERSION,
  kind: 'epic',
  title: 'Ship the widget',
  why: 'The widget is missing',
  doneWhen: ['the widget works'],
  children: [],
  labels: [],
  tracesTo: [],
};

function ctx(overrides: Partial<PanelContext> = {}): PanelContext {
  return { decomposition: { epic: EPIC, stories: [] }, doc: MINIMAL_DOC, story: story(), ...overrides };
}

describe('mentions', () => {
  it('returns false for an empty cue list', () => {
    expect(mentions(['anything at all'], [])).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(mentions(['This Has A CUE In It'], ['cue'])).toBe(true);
  });

  it('returns false when no cue is present', () => {
    expect(mentions(['nothing relevant here'], ['zzz'])).toBe(false);
  });
});

describe('storyText', () => {
  it('includes acceptance criteria and verification text', () => {
    const s = story({
      acceptanceCriteria: [
        {
          name: 'Distinctive Criterion Name',
          given: [],
          when: ['a distinctive when'],
          then: ['a distinctive then'],
          tracesTo: [],
        },
      ],
      verification: [{ command: 'a distinctive command', passWhen: 'a distinctive passWhen' }],
    });
    const text = storyText(s).join(' ');
    expect(text).toContain('Distinctive Criterion Name');
    expect(text).toContain('a distinctive when');
    expect(text).toContain('a distinctive then');
    expect(text).toContain('a distinctive command');
    expect(text).toContain('a distinctive passWhen');
  });
});

describe('engRepoContextRule', () => {
  it('fires when no files are attached', () => {
    const finding = engRepoContextRule(ctx({ story: story({ filesLikelyTouched: [] }) }));
    expect(finding?.persona).toBe('eng');
    expect(finding?.kind).toBe('assumption');
    expect(finding?.observation).toContain('no repo context is attached');
    expect(finding?.action.kind).toBe('question');
    if (finding?.action.kind === 'question') {
      expect(finding.action.text).toContain('Which files or modules');
    }
  });

  it('does not fire when files are attached', () => {
    expect(engRepoContextRule(ctx({ story: story({ filesLikelyTouched: ['src/widget.ts'] }) }))).toBeUndefined();
  });
});

describe('engAutomatedVerificationRule', () => {
  it('fires when every verification step is manual', () => {
    const finding = engAutomatedVerificationRule(
      ctx({ story: story({ verification: [{ command: 'manual: confirm it works', passWhen: 'it works' }] }) }),
    );
    expect(finding?.persona).toBe('eng');
    expect(finding?.kind).toBe('risk');
    expect(finding?.observation).toContain('every verification step');
    expect(finding?.action.kind).toBe('question');
    if (finding?.action.kind === 'question') {
      expect(finding.action.text).toContain('A manual check cannot gate CI');
    }
  });

  it('does not fire when a verification step has a real command', () => {
    expect(engAutomatedVerificationRule(ctx({ story: story() }))).toBeUndefined();
  });
});

describe('customerMeasurableValueRule', () => {
  it('fires when soThat is not stated measurably', () => {
    const finding = customerMeasurableValueRule(ctx({ story: story({ soThat: 'the widget works' }) }));
    expect(finding?.persona).toBe('customer');
    expect(finding?.kind).toBe('assumption');
    expect(finding?.observation).toContain('is not stated in a way');
    expect(finding?.action.kind).toBe('question');
    if (finding?.action.kind === 'question') {
      expect(finding.action.text).toContain('How would a');
    }
  });

  it('does not fire when soThat is measurable', () => {
    expect(
      customerMeasurableValueRule(ctx({ story: story({ soThat: 'usage increases by 20 percent' }) })),
    ).toBeUndefined();
  });
});

describe('customerAdoptionRule', () => {
  it('fires when nothing describes discovery or onboarding', () => {
    const finding = customerAdoptionRule(ctx({ story: story() }));
    expect(finding?.persona).toBe('customer');
    expect(finding?.kind).toBe('gap');
    expect(finding?.observation).toContain('discovers or starts using it');
    expect(finding?.action.kind).toBe('criterion');
    if (finding?.action.kind === 'criterion') {
      expect(finding.action.criterion.name).toContain('can discover');
    }
  });

  it('does not fire when discovery is described', () => {
    expect(
      customerAdoptionRule(ctx({ story: story({ inScope: ['ship the widget', 'help users discover the widget'] }) })),
    ).toBeUndefined();
  });
});

describe('supportFailurePathRule', () => {
  it('fires when nothing describes a failure path', () => {
    const finding = supportFailurePathRule(ctx({ story: story() }));
    expect(finding?.persona).toBe('support');
    expect(finding?.kind).toBe('gap');
    expect(finding?.observation).toContain('only describes the happy path');
    expect(finding?.action.kind).toBe('criterion');
    if (finding?.action.kind === 'criterion') {
      expect(finding.action.criterion.name).toContain('fails visibly');
    }
  });

  it('does not fire when a failure path is described', () => {
    const s = story({
      acceptanceCriteria: [
        {
          name: 'Widget error handling',
          given: ['a widget user'],
          when: ['the widget fails'],
          then: ['they see an error'],
          tracesTo: [],
        },
      ],
    });
    expect(supportFailurePathRule(ctx({ story: s }))).toBeUndefined();
  });
});

describe('supportRunbookRule', () => {
  it('fires when no documentation or runbook is named', () => {
    const finding = supportRunbookRule(ctx({ story: story() }));
    expect(finding?.persona).toBe('support');
    expect(finding?.kind).toBe('gap');
    expect(finding?.observation).toContain('no documentation or runbook is named');
    expect(finding?.action.kind).toBe('question');
    if (finding?.action.kind === 'question') {
      expect(finding.action.text).toContain('What does a support agent read');
    }
  });

  it('does not fire when documentation is named', () => {
    expect(supportRunbookRule(ctx({ story: story({ outOfScope: ['write documentation'] }) }))).toBeUndefined();
  });
});

describe('securityAuthorizationRule', () => {
  it('fires when neither the story nor any constraint names who may act', () => {
    const finding = securityAuthorizationRule(ctx({ story: story(), doc: MINIMAL_DOC }));
    expect(finding?.persona).toBe('security');
    expect(finding?.kind).toBe('gap');
    expect(finding?.observation).toContain('neither');
    expect(finding?.action.kind).toBe('question');
    if (finding?.action.kind === 'question') {
      expect(finding.action.text).toContain('Who is allowed to');
    }
  });

  it('does not fire when a constraint names who may act', () => {
    const doc = docWithConstraint('Only an admin with the export permission may run it, per SOC2');
    expect(securityAuthorizationRule(ctx({ story: story(), doc }))).toBeUndefined();
  });
});

describe('securityAbuseCaseRule', () => {
  it('fires when no criterion says what must be refused', () => {
    const finding = securityAbuseCaseRule(ctx({ story: story() }));
    expect(finding?.persona).toBe('security');
    expect(finding?.kind).toBe('risk');
    expect(finding?.observation).toContain('none says what must not be allowed');
    expect(finding?.action.kind).toBe('criterion');
    if (finding?.action.kind === 'criterion') {
      expect(finding.action.criterion.name).toContain('refuses the unauthorized case');
    }
  });

  it('does not fire when a criterion says what must be refused', () => {
    const s = story({
      acceptanceCriteria: [
        {
          name: 'Refuses unauthorized use',
          given: [],
          when: ['someone without permission tries'],
          then: ['the attempt is denied'],
          tracesTo: [],
        },
      ],
    });
    expect(securityAbuseCaseRule(ctx({ story: s }))).toBeUndefined();
  });
});

describe('opsRollbackRule', () => {
  it('fires when there is no rollout, flag, or rollback story', () => {
    const finding = opsRollbackRule(ctx({ story: story() }));
    expect(finding?.persona).toBe('ops');
    expect(finding?.kind).toBe('risk');
    expect(finding?.observation).toContain('no rollout, flag, or rollback story');
    expect(finding?.action.kind).toBe('criterion');
    if (finding?.action.kind === 'criterion') {
      expect(finding.action.criterion.name).toContain('can be turned off');
    }
  });

  it('does not fire when a rollout story exists', () => {
    expect(
      opsRollbackRule(ctx({ story: story({ outOfScope: ['manual rollback via feature flag'] }) })),
    ).toBeUndefined();
  });
});

describe('opsObservabilityRule', () => {
  it('fires when nothing emits a signal on-call could watch', () => {
    const finding = opsObservabilityRule(ctx({ story: story() }));
    expect(finding?.persona).toBe('ops');
    expect(finding?.kind).toBe('gap');
    expect(finding?.observation).toContain('nothing in');
    expect(finding?.action.kind).toBe('question');
    if (finding?.action.kind === 'question') {
      expect(finding.action.text).toContain('What signal tells on-call');
    }
  });

  it('does not fire when a signal is described', () => {
    expect(opsObservabilityRule(ctx({ story: story({ outOfScope: ['add a dashboard metric'] }) }))).toBeUndefined();
  });
});
