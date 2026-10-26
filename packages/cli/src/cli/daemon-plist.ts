// launchd plist rendering for the factoryd LaunchAgent, split from daemon.ts (max-lines).

export const FACTORYD_LABEL = 'com.onpar.factoryd';

function xmlEscape(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Pure renderer for ~/Library/LaunchAgents/com.onpar.factoryd.plist. KeepAlive
 *  relaunches factoryd after any exit; RunAtLoad starts it at login/bootstrap;
 *  launchd redirects stdout+stderr to the daemon log. ProgramArguments invokes
 *  the foreground `factory daemon run` command with its defaults. */
export function renderFactorydPlist(opts: { nodePath: string; cliScriptPath: string; logPath: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${FACTORYD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(opts.nodePath)}</string>
    <string>${xmlEscape(opts.cliScriptPath)}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
</dict>
</plist>
`;
}
