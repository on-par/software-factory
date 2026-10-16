// packages/cli/src/cli/program.test.ts — buildProgram registers every command under its help group (#2793) and main() stays a thin entry point (#2794)

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { HELP_GROUPS, OTHER_GROUP } from './help-groups.js';
import { PROGRAM_HANDLERS } from './index.js';
import { buildProgram } from './program.js';
import { registerAdvancedCommands } from './program-advanced.js';
import { registerObserveCommands } from './program-observe.js';
import { registerQueueCommands } from './program-queue.js';
import { registerRunWorkCommands } from './program-run-work.js';
import { registerSetupCommands } from './program-setup.js';

const countCommands = (cmd: Command): number => cmd.commands.reduce((n, c) => n + 1 + countCommands(c), 0);

describe('buildProgram', () => {
  it('buildProgram registers 58 commands', () => {
    expect(countCommands(buildProgram(PROGRAM_HANDLERS, {}))).toBe(58);
  });

  it('each help-group registrar registers exactly its HELP_GROUPS commands', () => {
    const pairs: [(p: Command) => void, string][] = [
      [(p) => registerRunWorkCommands(p, PROGRAM_HANDLERS), 'Run work:'],
      [(p) => registerSetupCommands(p, PROGRAM_HANDLERS), 'Setup:'],
      [(p) => registerQueueCommands(p, PROGRAM_HANDLERS), 'Queue:'],
      [(p) => registerObserveCommands(p, PROGRAM_HANDLERS, {}), 'Observe:'],
      [(p) => registerAdvancedCommands(p, PROGRAM_HANDLERS, {}), 'Advanced / experimental:'],
    ];
    for (const [register, heading] of pairs) {
      const program = new Command();
      register(program);
      const expected = HELP_GROUPS.find((g) => g.heading === heading)!.commands;
      expect(program.commands.map((c) => c.name()).sort()).toEqual([...expected].sort());
    }
  });

  it('no command falls into the Other group', () => {
    const program = buildProgram(PROGRAM_HANDLERS, {});
    for (const cmd of program.commands) expect(cmd.helpGroup()).not.toBe(OTHER_GROUP);
  });

  it('init registers -y/--yes alongside --force', () => {
    const init = buildProgram(PROGRAM_HANDLERS, {}).commands.find((c) => c.name() === 'init');
    expect(init?.options.some((o) => o.long === '--yes' && o.short === '-y')).toBe(true);
    expect(init?.options.some((o) => o.long === '--force')).toBe(true);
  });

  it('check keeps its ready alias and the root keeps --state-root', () => {
    const program = buildProgram(PROGRAM_HANDLERS, {});
    expect(program.commands.find((c) => c.name() === 'check')?.aliases()).toEqual(['ready']);
    expect(program.options.some((o) => o.long === '--state-root')).toBe(true);
  });
});

describe('main', () => {
  it('main() in cli/index.ts is 100 lines or fewer', () => {
    const lines = readFileSync(new URL('./index.ts', import.meta.url), 'utf8').split('\n');
    const start = lines.findIndex((l) => /^(export )?(async )?function main\(/.test(l));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((l, i) => i > start && l.startsWith('}'));
    expect(end).toBeGreaterThan(start);
    expect(end - start + 1).toBeLessThanOrEqual(100);
  });
});
