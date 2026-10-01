// packages/cli/src/cli/help-groups.ts — section headings and order for `factory --help`

import type { Command } from 'commander';

export interface HelpGroup {
  heading: string;
  /** Top-level command names, in the order they should appear under the heading. */
  commands: readonly string[];
  /** Put Commander's implicit `help [command]` entry under this heading. */
  includesHelp?: boolean;
}

/** Heading for any registered command missing from the table, so a new command still shows up. */
export const OTHER_GROUP = 'Other:';

/** The shipped `factory --help` layout: everyday commands first, experimental ones last. */
export const HELP_GROUPS: readonly HelpGroup[] = [
  {
    heading: 'Run work:',
    commands: ['ship', 'run-issue', 'run-brief', 'run', 'supervise', 'land', 'resume-approved', 'stop', 'resume'],
  },
  {
    heading: 'Setup:',
    commands: ['init', 'doctor', 'constitution', 'models', 'migrate'],
    includesHelp: true,
  },
  { heading: 'Queue:', commands: ['queue', 'triage', 'check'] },
  { heading: 'Observe:', commands: ['status', 'logs', 'tui', 'cost', 'usage', 'kpis', 'classifier'] },
  {
    heading: 'Advanced / experimental:',
    commands: ['worktree', 'reset', 'daemon', 'proxy', 'hosted', 'local-small-dry-run', 'local-small-overnight'],
  },
];

/** Assign each top-level command its help heading and reorder `program.commands` to match
 *  the table. Commander renders groups in order of first appearance, so the reorder is what
 *  puts "Run work:" first. Only help layout changes — command parsing ignores the order. */
export function applyHelpGroups(program: Command, groups: readonly HelpGroup[] = HELP_GROUPS): void {
  const byName = new Map(program.commands.map((cmd) => [cmd.name(), cmd]));
  const ordered: Command[] = [];
  for (const group of groups) {
    for (const name of group.commands) {
      const cmd = byName.get(name);
      if (!cmd) continue;
      cmd.helpGroup(group.heading);
      ordered.push(cmd);
      byName.delete(name);
    }
  }
  for (const cmd of byName.values()) {
    cmd.helpGroup(OTHER_GROUP);
    ordered.push(cmd);
  }
  // Commander types `commands` as readonly but keeps a plain array; reorder it in place.
  (program.commands as Command[]).splice(0, program.commands.length, ...ordered);

  const helpGroup = groups.find((g) => g.includesHelp);
  if (helpGroup) {
    program.commandsGroup(helpGroup.heading);
    program.helpCommand(true);
  }
}
