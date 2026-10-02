// src/filing/upstream.ts — Minimal, redacted upstream factory report (#1858). Never includes target-repo content.

import type { FailoverReason, FailurePhase, FingerprintedFailure } from '../types/index.js';
import { type RedactionContext, redactText } from './redact.js';
import { fenceExcerpt, stripHiddenContent } from './sanitize.js';

export const UPSTREAM_TITLE_PREFIX = '[factory-report]';

const MAX_FRAMES = 20;
const MAX_TITLE_CHARS = 120;
const MAX_MESSAGE_CHARS = 300;

export function upstreamReportMarker(fingerprint: string): string {
  const safeFp = /^[A-Za-z0-9_-]{1,64}$/.test(fingerprint) ? fingerprint : 'invalid';
  return `<!-- factory-upstream-report v1 fp:${safeFp} -->`;
}

export interface UpstreamReportInput {
  factoryVersion: string;
  factoryCommit: string | null;
  phase: FailurePhase;
  reason: FailoverReason;
  component: string;
  fingerprint: string;
  error: { name: string; message: string };
  /** Factory-package frames, already package-relative (factoryStackFrames output). */
  frames: readonly string[];
  harness: string | null;
  model: string;
  os: string;
  nodeVersion: string;
  redaction: RedactionContext;
}

export interface UpstreamReport {
  title: string;
  body: string;
}

export interface UpstreamEnvironment {
  factoryVersion: string;
  factoryCommit: string | null;
  os: string;
  nodeVersion: string;
  redaction?: RedactionContext;
}

const MAX_LINE_CHARS = 1000;
const LOCATION_MARKERS = ['node_modules/@on-par/factory-', '/packages/'];
const PACKAGE_LOCATION_RE = /^(core|cli|config)\/([\w./-]+):(\d+)(?::(\d+))?$/;

/** Split a trimmed `at …` line into function name and location with linear string scans. */
function splitFrame(line: string): { fn: string | null; location: string } | null {
  const t = line.trim();
  if (t.length > MAX_LINE_CHARS || !t.startsWith('at ')) return null;
  const rest = t.slice(3).trim();
  const open = rest.indexOf(' (');
  if (open !== -1 && rest.endsWith(')')) return { fn: rest.slice(0, open).trim(), location: rest.slice(open + 2, -1) };
  return { fn: null, location: rest };
}

/** Stack frames that resolve inside the factory packages, rewritten package-relative. */
export function factoryStackFrames(text: string, ctx: RedactionContext = {}): string[] {
  const frames: string[] = [];
  for (const line of text.split('\n')) {
    if (frames.length >= MAX_FRAMES) break;
    const parts = splitFrame(line);
    if (!parts) continue;
    const location = parts.location.replace(/^file:\/\//, '').replaceAll('\\', '/');
    let loc: RegExpExecArray | null = null;
    for (const marker of LOCATION_MARKERS) {
      const at = location.lastIndexOf(marker);
      if (at === -1) continue;
      loc = PACKAGE_LOCATION_RE.exec(location.slice(at + marker.length));
      if (loc) break;
    }
    if (!loc) continue;
    const [, pkg, rel, ln, col] = loc;
    if (!rel) continue;
    const where = `@on-par/factory-${pkg}/${rel}:${ln}${col ? `:${col}` : ''}`;
    const fn = parts.fn;
    if (fn && /^[\w$.<>[\] ]{1,120}$/.test(fn)) {
      frames.push(`at ${redactText(fn, ctx)} (${where})`);
    } else {
      frames.push(`at ${where}`);
    }
  }
  return frames;
}

const ERROR_LINE_RE = /^(?:Uncaught )?([A-Z]\w*(?:Error|Exception))(?::(.*))?$/;

export function upstreamInputFromEvidence(
  failure: FingerprintedFailure,
  env: UpstreamEnvironment,
): UpstreamReportInput {
  const { evidence } = failure;
  const base = env.redaction ?? {};
  const redaction: RedactionContext = {
    ...base,
    repoSlugs: [
      ...(base.repoSlugs ?? []),
      ...[evidence.repo, evidence.relatedIssue?.repo].filter((s): s is string => !!s),
    ],
  };

  let error = { name: 'UnknownError', message: '(no error line found)' };
  for (const line of evidence.eventExcerpt.split('\n')) {
    const m = line.length > MAX_LINE_CHARS ? null : ERROR_LINE_RE.exec(line.trim());
    if (m?.[1]) {
      error = { name: m[1], message: (m[2] ?? '').trim() };
      break;
    }
  }

  const component = evidence.component;
  const harness = component.startsWith('check:') || component.startsWith('custom_') ? null : component;

  return {
    factoryVersion: env.factoryVersion,
    factoryCommit: env.factoryCommit,
    phase: evidence.phase,
    reason: evidence.reason,
    component,
    fingerprint: failure.fingerprint,
    error,
    frames: factoryStackFrames(evidence.eventExcerpt, redaction),
    harness,
    model: evidence.model,
    os: env.os,
    nodeVersion: env.nodeVersion,
    redaction,
  };
}

function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function cell(s: string): string {
  return oneLine(s).replaceAll('\\', '\\\\').replaceAll('|', '\\|');
}

export function buildUpstreamReport(input: UpstreamReportInput): UpstreamReport {
  const clean = (s: string): string => redactText(s, input.redaction);
  const token = (s: string | null): string => (s && /^[\w.+-]{1,64}$/.test(s) ? s : 'unknown');

  const message = oneLine(
    clean(input.error.message.replace(/'[^']{0,200}'|"[^"]{0,200}"|`[^`]{0,200}`/g, '<str>')),
  ).slice(0, MAX_MESSAGE_CHARS);
  const errorClass = /^[A-Z][A-Za-z0-9_]{0,63}$/.test(input.error.name) ? input.error.name : 'Error';
  const component = input.component.startsWith('custom_') ? 'custom' : clean(input.component);
  const harness = input.harness === null ? 'unknown' : clean(input.harness);
  const frames = input.frames.map((f) => stripHiddenContent(f)).filter((f) => f.length > 0);

  const title = `${UPSTREAM_TITLE_PREFIX} ${input.phase} ${input.reason} in ${oneLine(component)}: ${errorClass}`.slice(
    0,
    MAX_TITLE_CHARS,
  );

  const rows: Array<[string, string]> = [
    ['Factory version', token(input.factoryVersion)],
    ['Factory commit', token(input.factoryCommit)],
    ['Phase', input.phase],
    ['Failure reason', input.reason],
    ['Component', component],
    ['Fingerprint', upstreamReportMarker(input.fingerprint).replace(/^.* fp:| -->$/g, '')],
    ['Harness', harness],
    ['Model', clean(input.model)],
    ['OS', clean(input.os)],
    ['Node', clean(input.nodeVersion)],
  ];

  const body = [
    '## Factory upstream report',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`),
    '',
    '## Error',
    '',
    fenceExcerpt(`${errorClass}: ${message}`),
    '',
    '## Stack (factory packages only)',
    '',
    frames.length > 0 ? fenceExcerpt(frames.join('\n')) : '_No factory-package frames._',
    '',
    'This report contains factory-side facts only. Target-repo names, paths, branches, issue text, diffs and log excerpts are never included.',
    '',
    upstreamReportMarker(input.fingerprint),
    '',
  ].join('\n');

  return { title, body };
}
