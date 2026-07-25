// src/convention.ts — repo-wide ADR style descriptor (#467).
//
// Sources for the three shapes this kit understands: Michael Nygard's original template
// (https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions), the
// numbered-dot variant popularized by adr.github.io, and MADR
// (https://adr.github.io/madr/), which fronts metadata with YAML frontmatter. This repo's
// own docs/adr/README.md already declares the Nygard template as house style, which is why
// NYGARD_CONVENTION is the fallback below.

export interface AdrConvention {
  /** '# ADR-0001: T' | '# 1. T' | '# T' */
  titleStyle: 'adr-prefix' | 'numbered-dot' | 'plain';
  /** Zero-pad width for the number in titles and filenames. */
  numberWidth: number;
  /** Where Status/Date live: '- Status: X' | '## Status\n\nX' | YAML frontmatter. */
  metaStyle: 'bullet-list' | 'sections' | 'frontmatter';
  /** Exact prefix for bullet-list metadata lines: '- ' or '' (bare 'Date: X'). */
  metaBullet: string;
  statusLabel: string;
  dateLabel: string;
  contextLabel: string;
  decisionLabel: string;
  consequencesLabel: string;
  referencesLabel: string;
  /** Heading marker for sections, including the trailing space. */
  headingPrefix: string;
  eol: '\n' | '\r\n';
  /** Whether files end with a newline. */
  trailingNewline: boolean;
}

/** The Michael Nygard template — the fallback when a repo has no ADR convention yet. */
export const NYGARD_CONVENTION: AdrConvention = {
  titleStyle: 'adr-prefix',
  numberWidth: 4,
  metaStyle: 'bullet-list',
  metaBullet: '- ',
  statusLabel: 'Status',
  dateLabel: 'Date',
  contextLabel: 'Context',
  decisionLabel: 'Decision',
  consequencesLabel: 'Consequences',
  referencesLabel: 'References',
  headingPrefix: '## ',
  eol: '\n',
  trailingNewline: true,
};
