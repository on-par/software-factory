// src/serialize.ts — serializeAdr, the byte-stable inverse of parseAdr (#467).
import type { Adr, AdrReference } from './adr.js';
import type { AdrConvention } from './convention.js';
import { NYGARD_CONVENTION } from './convention.js';

type KnownField = 'status' | 'date' | 'context' | 'decision' | 'consequences' | 'references';

function matchKnownField(heading: string): KnownField | undefined {
  const trimmed = heading.trim();
  if (/^status$/i.test(trimmed)) return 'status';
  if (/^date$/i.test(trimmed)) return 'date';
  if (/^context/i.test(trimmed)) return 'context';
  if (/^decision/i.test(trimmed)) return 'decision';
  if (/^consequences$/i.test(trimmed)) return 'consequences';
  if (/^(references|links)$/i.test(trimmed)) return 'references';
  return undefined;
}

function padNumber(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function renderH1(adr: Adr, convention: AdrConvention): string {
  if (convention.titleStyle === 'adr-prefix' && adr.number !== undefined) {
    return `# ADR-${padNumber(adr.number, convention.numberWidth)}: ${adr.title}`;
  }
  if (convention.titleStyle === 'numbered-dot' && adr.number !== undefined) {
    return `# ${adr.number}. ${adr.title}`;
  }
  return `# ${adr.title}`;
}

function renderReferences(references: readonly AdrReference[]): string {
  return references
    .map((ref) => (ref.url ? `${ref.marker} [${ref.text}](${ref.url})` : `${ref.marker} ${ref.text}`))
    .join('\n');
}

function renderSectionBlock(headingPrefix: string, heading: string, body: string): string {
  return body === '' ? `${headingPrefix}${heading}` : `${headingPrefix}${heading}\n\n${body}`;
}

function fieldBody(adr: Adr, field: KnownField): string {
  switch (field) {
    case 'status':
      return adr.status;
    case 'date':
      return adr.date;
    case 'context':
      return adr.context;
    case 'decision':
      return adr.decision;
    case 'consequences':
      return adr.consequences;
    case 'references':
      return renderReferences(adr.references);
  }
}

export function serializeAdr(adr: Adr, convention: AdrConvention = NYGARD_CONVENTION): string {
  const blocks: string[] = [];
  const hasSectionOrder = adr.sectionOrder.length > 0;
  const sectionFields = new Set(
    adr.sectionOrder
      .map((heading) => matchKnownField(heading))
      .filter((field): field is KnownField => field !== undefined),
  );

  if (convention.metaStyle === 'frontmatter') {
    const frontmatterLines = ['---'];
    if (adr.status !== '') frontmatterLines.push(`status: ${adr.status}`);
    if (adr.date !== '') frontmatterLines.push(`date: ${adr.date}`);
    frontmatterLines.push('---');
    blocks.push(frontmatterLines.join('\n'));
  }

  blocks.push(renderH1(adr, convention));

  if (convention.metaStyle !== 'frontmatter') {
    if (hasSectionOrder) {
      const preambleLines: string[] = [];
      if (!sectionFields.has('status') && adr.status !== '') {
        preambleLines.push(`${convention.metaBullet}${convention.statusLabel}: ${adr.status}`);
      }
      if (!sectionFields.has('date') && adr.date !== '') {
        preambleLines.push(`${convention.metaBullet}${convention.dateLabel}: ${adr.date}`);
      }
      if (preambleLines.length > 0) blocks.push(preambleLines.join('\n'));
    } else if (convention.metaStyle === 'bullet-list') {
      const preambleLines: string[] = [];
      if (adr.status !== '') preambleLines.push(`${convention.metaBullet}${convention.statusLabel}: ${adr.status}`);
      if (adr.date !== '') preambleLines.push(`${convention.metaBullet}${convention.dateLabel}: ${adr.date}`);
      if (preambleLines.length > 0) blocks.push(preambleLines.join('\n'));
    }
  }

  if (hasSectionOrder) {
    for (const heading of adr.sectionOrder) {
      const field = matchKnownField(heading);
      const body = field
        ? fieldBody(adr, field)
        : (adr.extraSections.find((section) => section.heading === heading)?.body ?? '');
      blocks.push(renderSectionBlock(convention.headingPrefix, heading, body));
    }
  } else {
    if (convention.metaStyle === 'sections') {
      blocks.push(renderSectionBlock(convention.headingPrefix, convention.statusLabel, adr.status));
      blocks.push(renderSectionBlock(convention.headingPrefix, convention.dateLabel, adr.date));
    }
    blocks.push(renderSectionBlock(convention.headingPrefix, convention.contextLabel, adr.context));
    blocks.push(renderSectionBlock(convention.headingPrefix, convention.decisionLabel, adr.decision));
    blocks.push(renderSectionBlock(convention.headingPrefix, convention.consequencesLabel, adr.consequences));
    if (adr.references.length > 0) {
      blocks.push(
        renderSectionBlock(convention.headingPrefix, convention.referencesLabel, renderReferences(adr.references)),
      );
    }
  }

  let result = blocks.join('\n\n');
  if (convention.trailingNewline) result += '\n';
  if (convention.eol === '\r\n') result = result.replace(/\n/g, '\r\n');
  return result;
}
