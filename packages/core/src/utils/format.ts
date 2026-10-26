// src/utils/format.ts — Hand-rolled ANSI formatter for the live `[factory]` log stream.
// No new dependency: keep core's dep list (execa, @octokit/rest, gray-matter, zod) stable.

import { severityOf } from '../events/kinds.js';
import type { LogLevel } from '../types/index.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

export function colorEnabled(
  stream: { isTTY?: boolean } | undefined = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.FORCE_COLOR !== undefined) {
    return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== '';
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') {
    return false;
  }
  return stream?.isTTY === true;
}

type Category = 'phase' | 'ok' | 'warn' | 'error' | 'router' | 'other';

// Rendering-only groupings: which "info"-severity kinds get the phase (▶) vs
// ok (✓) symbol. Not part of the shared EVENT_TRAITS vocabulary (#663) — the
// distinction is cosmetic to this console renderer, not a severity/park/lane
// classification other consumers need.
const PHASE_TYPES = new Set(['plan', 'build', 'check', 'ship', 'triage']);
const OK_TYPES = new Set(['ready', 'recovered', 'pr_opened', 'approval_granted', 'run-done', 'lane-start']);

function categorize(type: string): Category {
  if (PHASE_TYPES.has(type)) return 'phase';
  if (OK_TYPES.has(type)) return 'ok';
  const severity = severityOf(type);
  if (severity === 'warn') return 'warn';
  if (severity === 'error') return 'error';
  if (type === 'router') return 'router';
  return 'other';
}

/** Maps an event `type` to its log severity, via the shared EVENT_TRAITS table (#663). */
export function levelForType(type: string): LogLevel {
  return severityOf(type);
}

const ROUTER_HIGHLIGHT = /failed|failing over|rate limited|usage cap|timed out|cooldown|non-retryable/i;

const CATEGORY_STYLE: Record<Category, { symbol: string; typeColor: string }> = {
  phase: { symbol: '▶', typeColor: `${BOLD}${CYAN}` },
  ok: { symbol: '✓', typeColor: GREEN },
  warn: { symbol: '⚠', typeColor: `${BOLD}${YELLOW}` },
  error: { symbol: '✗', typeColor: `${BOLD}${RED}` },
  router: { symbol: '→', typeColor: DIM },
  other: { symbol: '•', typeColor: DIM },
};

/** Strip terminal control characters (C0, DEL, C1 — which includes the bare CSI byte) from text that
 *  came from GitHub or the event log, so a crafted issue title or label cannot move the cursor, clear
 *  the pane, retitle the terminal, or spoof a row (#1362, #1634). */
export function sanitizeTerminalText(text: string): string {
  // oxlint-disable-next-line no-control-regex -- stripping terminal control characters on purpose
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

export function formatEventLine(
  type: string,
  issue: string | number,
  msg: string,
  opts: { color?: boolean; lane?: string; ts?: string } = {},
): string {
  const cleanType = sanitizeTerminalText(type);
  const cleanIssue = sanitizeTerminalText(String(issue));
  const cleanMsg = sanitizeTerminalText(msg);
  const lane = opts.lane ? sanitizeTerminalText(opts.lane) : undefined;
  const ts = opts.ts ? sanitizeTerminalText(opts.ts) : undefined;

  if (!opts.color) {
    const tsPrefix = ts ? `[${ts}] ` : '';
    return lane
      ? `${tsPrefix}[factory] ${cleanType} #${cleanIssue} [${lane}]: ${cleanMsg}`
      : `${tsPrefix}[factory] ${cleanType} #${cleanIssue}: ${cleanMsg}`;
  }

  const category = categorize(cleanType);
  const { symbol, typeColor } = CATEGORY_STYLE[category];
  const coloredType = `${typeColor}${cleanType.padEnd(7)}${RESET}`;

  let renderedMsg: string;
  if (category === 'warn' || category === 'error') {
    renderedMsg = `${category === 'warn' ? YELLOW : RED}${cleanMsg}${RESET}`;
  } else if (category === 'router') {
    renderedMsg = ROUTER_HIGHLIGHT.test(cleanMsg) ? `${YELLOW}${cleanMsg}${RESET}` : `${DIM}${cleanMsg}${RESET}`;
  } else {
    renderedMsg = cleanMsg;
  }

  const laneToken = lane ? ` ${DIM}[${lane}]${RESET}` : '';
  const tsToken = ts ? `${DIM}[${ts}]${RESET} ` : '';

  return `${tsToken}${DIM}[factory]${RESET} ${symbol} ${coloredType} ${BOLD}#${cleanIssue}${RESET}${laneToken}: ${renderedMsg}`;
}
