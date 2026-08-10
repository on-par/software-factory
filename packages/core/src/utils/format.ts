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
const OK_TYPES = new Set(['ready', 'recovered', 'approval_granted', 'run-done', 'lane-start']);

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

export function formatEventLine(
  type: string,
  issue: string | number,
  msg: string,
  opts: { color?: boolean; lane?: string } = {},
): string {
  if (!opts.color) {
    return opts.lane ? `[factory] ${type} #${issue} [${opts.lane}]: ${msg}` : `[factory] ${type} #${issue}: ${msg}`;
  }

  const category = categorize(type);
  const { symbol, typeColor } = CATEGORY_STYLE[category];
  const coloredType = `${typeColor}${type.padEnd(7)}${RESET}`;

  let renderedMsg: string;
  if (category === 'warn' || category === 'error') {
    renderedMsg = `${category === 'warn' ? YELLOW : RED}${msg}${RESET}`;
  } else if (category === 'router') {
    renderedMsg = ROUTER_HIGHLIGHT.test(msg) ? `${YELLOW}${msg}${RESET}` : `${DIM}${msg}${RESET}`;
  } else {
    renderedMsg = msg;
  }

  const laneToken = opts.lane ? ` ${DIM}[${opts.lane}]${RESET}` : '';

  return `${DIM}[factory]${RESET} ${symbol} ${coloredType} ${BOLD}#${issue}${RESET}${laneToken}: ${renderedMsg}`;
}
