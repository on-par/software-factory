import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandResult } from '../utils/command-runner.js';
import type { CheckerContext } from './index.js';

const ESC = String.fromCharCode(27);
const CSI_SEQUENCE_OR_CHARSET_SELECT_AFTER_ESC = /^\[[0-9;?]*[A-Za-z]|^[()][A-Za-z0-9]/;

export function stripAnsi(text: string): string {
  return text
    .split(ESC)
    .map((part, index) => (index === 0 ? part : part.replace(CSI_SEQUENCE_OR_CHARSET_SELECT_AFTER_ESC, '')))
    .join('');
}

export async function writeCommandLog(ctx: CheckerContext, name: string, r: CommandResult): Promise<string | null> {
  if (!ctx.outputLogDir) return null;
  const path = join(ctx.outputLogDir, `${name.replace(/[^A-Za-z0-9.]+/g, '-')}.log`);
  return writeDiagnosticLogThatNeverChangesVerdict(ctx.outputLogDir, path, () =>
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
}

async function writeDiagnosticLogThatNeverChangesVerdict(
  dir: string,
  path: string,
  render: () => string,
): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, render());
    return path;
  } catch {
    return null;
  }
}
