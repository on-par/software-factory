import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { applyHelpGroups, HELP_GROUPS, OTHER_GROUP } from './help-groups.js';

function programWith(...names: string[]): Command {
  const program = new Command('factory');
  for (const name of names) program.command(name).description(`${name} description`);
  return program;
}

describe('applyHelpGroups', () => {
  it('reorders commands to follow the group table and assigns each its heading', () => {
    const program = programWith('status', 'init', 'land', 'ship');
    applyHelpGroups(program, [
      { heading: 'Run work:', commands: ['ship', 'land'] },
      { heading: 'Setup:', commands: ['init'] },
      { heading: 'Observe:', commands: ['status'] },
    ]);

    expect(program.commands.map((c) => c.name())).toEqual(['ship', 'land', 'init', 'status']);
    expect(program.commands.map((c) => c.helpGroup())).toEqual(['Run work:', 'Run work:', 'Setup:', 'Observe:']);
  });

  it('puts unlisted commands last, under the fallback heading, in registration order', () => {
    const program = programWith('zeta', 'ship', 'alpha');
    applyHelpGroups(program, [{ heading: 'Run work:', commands: ['ship'] }]);

    expect(program.commands.map((c) => c.name())).toEqual(['ship', 'zeta', 'alpha']);
    expect(program.commands.map((c) => c.helpGroup())).toEqual(['Run work:', OTHER_GROUP, OTHER_GROUP]);
  });

  it('ignores listed names that are not registered', () => {
    const program = programWith('ship');
    applyHelpGroups(program, [{ heading: 'Run work:', commands: ['ship', 'gone'] }]);

    expect(program.commands.map((c) => c.name())).toEqual(['ship']);
  });

  it('renders group headings in table order in the help text', () => {
    const program = programWith('status', 'init', 'ship');
    applyHelpGroups(program, [
      { heading: 'Run work:', commands: ['ship'] },
      { heading: 'Setup:', commands: ['init'], includesHelp: true },
      { heading: 'Observe:', commands: ['status'] },
    ]);
    const help = program.helpInformation();
    const setup = help.slice(help.indexOf('Setup:'), help.indexOf('Observe:'));
    expect(setup).toContain('help [command]');

    const order = ['Run work:', 'Setup:', 'Observe:'].map((h) => help.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(help).not.toContain('Commands:');
  });

  it('lists every command at most once across the shipped table', () => {
    const names = HELP_GROUPS.flatMap((g) => g.commands);
    expect(new Set(names).size).toBe(names.length);
  });
});
