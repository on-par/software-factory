// src/utils/shell-escape.ts — single-quote a value for safe use inside a shell command

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
