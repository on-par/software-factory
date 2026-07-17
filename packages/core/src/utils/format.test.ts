import { describe, expect, it } from 'vitest';
import { colorEnabled, formatEventLine, levelForType } from './format.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

describe('colorEnabled', () => {
  it('is false when NO_COLOR is set even on a TTY', () => {
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
  });

  it('is false when FORCE_COLOR=0', () => {
    expect(colorEnabled({ isTTY: true }, { FORCE_COLOR: '0' })).toBe(false);
  });

  it('is true when FORCE_COLOR=1 even on a non-TTY', () => {
    expect(colorEnabled({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
  });

  it('FORCE_COLOR takes precedence over NO_COLOR when both are set', () => {
    expect(colorEnabled({ isTTY: false }, { FORCE_COLOR: '1', NO_COLOR: '1' })).toBe(true);
    expect(colorEnabled({ isTTY: true }, { FORCE_COLOR: '0', NO_COLOR: '1' })).toBe(false);
  });

  it('falls back to isTTY when no env override is set', () => {
    expect(colorEnabled({ isTTY: true }, {})).toBe(true);
    expect(colorEnabled({ isTTY: false }, {})).toBe(false);
    expect(colorEnabled(undefined, {})).toBe(false);
    expect(colorEnabled({}, {})).toBe(false);
  });

  it('ignores an empty-string NO_COLOR', () => {
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '' })).toBe(true);
  });
});

describe('formatEventLine — plain mode', () => {
  it('is byte-identical to the legacy format', () => {
    expect(formatEventLine('plan', 209, 'msg')).toBe('[factory] plan #209: msg');
  });

  it.each(['plan', 'ready', 'warn', 'fail', 'router', 'worktree-gc'])('contains no ANSI escape for type=%s', (type) => {
    const line = formatEventLine(type, 1, 'hello');
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/\x1b\[/);
  });
});

describe('formatEventLine — color mode', () => {
  it.each([
    ['plan', '▶', `${BOLD}${CYAN}`, 'phase'],
    ['build', '▶', `${BOLD}${CYAN}`, 'phase'],
    ['check', '▶', `${BOLD}${CYAN}`, 'phase'],
    ['ship', '▶', `${BOLD}${CYAN}`, 'phase'],
    ['triage', '▶', `${BOLD}${CYAN}`, 'phase'],
    ['ready', '✓', GREEN, 'ok'],
    ['recovered', '✓', GREEN, 'ok'],
    ['approval_granted', '✓', GREEN, 'ok'],
    ['run-done', '✓', GREEN, 'ok'],
    ['warn', '⚠', `${BOLD}${YELLOW}`, 'warn'],
    ['rework', '⚠', `${BOLD}${YELLOW}`, 'warn'],
    ['approval_requested', '⚠', `${BOLD}${YELLOW}`, 'warn'],
    ['fail', '✗', `${BOLD}${RED}`, 'error'],
    ['escalate', '✗', `${BOLD}${RED}`, 'error'],
    ['ship_denied', '✗', `${BOLD}${RED}`, 'error'],
    ['router', '→', DIM, 'router'],
    ['worktree-gc', '•', DIM, 'other'],
  ])('renders %s as the %s category', (type, symbol, color) => {
    const line = formatEventLine(type, 209, 'raw message text', { color: true });
    expect(line).toContain(symbol);
    expect(line).toContain(color);
    expect(line).toContain('[factory]');
    expect(line).toContain('#209');
    expect(line).toContain('raw message text');
  });
});

describe('formatEventLine — router highlight', () => {
  it('highlights failover/warning-shaped router messages in yellow', () => {
    const line = formatEventLine('router', 209, 'claude-x failed (timeout) on build — failing over', { color: true });
    expect(line).toContain(YELLOW);
  });

  it('renders routine router progress messages dim, not yellow', () => {
    const line = formatEventLine('router', 209, 'Trying gpt for plan (attempt 1)', { color: true });
    expect(line).not.toContain(YELLOW);
    expect(line).toContain(DIM);
  });
});

describe('formatEventLine — unknown type', () => {
  it('falls into the other category', () => {
    const line = formatEventLine('worktree-gc', 1, 'swept 3 worktrees', { color: true });
    expect(line).toContain('•');
    expect(line).toContain(DIM);
  });
});

describe('formatEventLine — lane option', () => {
  it('renders the lane after the issue in plain mode', () => {
    expect(formatEventLine('plan', 209, 'msg', { lane: 'app' })).toBe('[factory] plan #209 [app]: msg');
  });

  it('renders the lane wrapped in DIM after the issue in color mode', () => {
    const line = formatEventLine('plan', 209, 'msg', { color: true, lane: 'app' });
    expect(line).toContain(`${DIM}[app]${RESET}`);
    expect(line).toContain('#209');
  });

  it('is byte-identical to the legacy format when no lane is passed', () => {
    expect(formatEventLine('plan', 209, 'msg')).toBe('[factory] plan #209: msg');
    expect(formatEventLine('plan', 209, 'msg', { color: true })).not.toContain('[app]');
  });
});

describe('levelForType', () => {
  it.each([
    ['warn', 'warn'],
    ['rework', 'warn'],
    ['approval_requested', 'warn'],
    ['stopped', 'warn'],
    ['fail', 'error'],
    ['escalate', 'error'],
    ['ship_denied', 'error'],
    ['parked', 'error'],
    ['plan', 'info'],
    ['ready', 'info'],
    ['lane-start', 'info'],
    ['some-unknown-type', 'info'],
  ])('maps %s to level %s', (type, level) => {
    expect(levelForType(type)).toBe(level);
  });
});
