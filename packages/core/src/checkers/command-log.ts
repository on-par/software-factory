// src/checkers/command-log.ts — shared helpers for checker command output (ANSI stripping, full-output logs)

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandResult } from '../utils/command-runner.js';
import type { CheckerContext } from './index.js';

/** Removes terminal escape sequences: SGR/CSI (`ESC[1;31m`, `ESC[2K`) and charset selects (`ESC(B`). */
export function stripAnsi(text: string): string {
  return text
    .split(String.fromCharCode(27))
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;?]*[A-Za-z]|^[()][A-Za-z0-9]/, '')))
    .join('');
}

/** Writes a failed command's full stdout/stderr under ctx.outputLogDir. Returns the path,
 *  or null when no log dir is set or the write fails — the log is a diagnostic side
 *  channel and must never change a checker's verdict. */
export async function writeCommandLog(ctx: CheckerContext, name: string, r: CommandResult): Promise<string | null> {
  if (!ctx.outputLogDir) return null;
  const path = join(ctx.outputLogDir, `${name.replace(/[^A-Za-z0-9.]+/g, '-')}.log`);
  try {
    await mkdir(ctx.outputLogDir, { recursive: true });
    await writeFile(
      path,
      [
        `$ ${r.command.join(' ')}`,
        `exit code: ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`,
        '',
        '--- stdout ---',
        stripAnsi(r.stdout),
        '--- stderr ---',
        stripAnsi(r.stderr),
        '',
      ].join('\n'),
    );
    return path;
  } catch {
    return null;
  }
}
