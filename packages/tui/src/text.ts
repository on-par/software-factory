/** Strip terminal control characters (C0, DEL, C1 — which includes the bare CSI byte) from text that
 *  came from GitHub or the event log, so a crafted issue title or label cannot move the cursor, clear
 *  the pane, or spoof a row. Ink writes strings verbatim, so this is the only guard (#1362). */
export function sanitizeTerminalText(text: string): string {
  // oxlint-disable-next-line no-control-regex -- stripping terminal control characters on purpose
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}
