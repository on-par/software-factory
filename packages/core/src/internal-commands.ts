// packages/core/src/internal-commands.ts — the command runner and command output session names of ./internal, split out to keep internal.ts under its line ceiling

export { runCommand } from './utils/command-runner.js';
export { closeCommandOutputSession, startCommandOutputSession } from './command-output/tap.js';
