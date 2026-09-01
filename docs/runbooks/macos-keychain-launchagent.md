# macOS Claude keychain access with a LaunchAgent

Reference: #1014. This is the Mini factory operations path for Claude Max workers on macOS.

## Symptom

Inside tmux, `claude -p` can fail with `Failed to authenticate: OAuth session expired and could not be refreshed`. The metadata-only probe below exits 44 with `SecKeychainSearchCopyNext`:

```sh
security find-generic-password -s 'Claude Code-credentials'
```

The same commands succeed in a login Terminal, remote Shell, or LaunchAgent. A factory PLAN phase then fails with `local_auth` in about one second and parks the issue.

## Cause

Claude Code stores OAuth credentials in the login keychain. Refreshing a token needs keychain read/write access. A raw tmux pane, even with `reattach-to-user-namespace`, does not carry the login-keychain ACL or security session. The `gui/$(id -u)` launchd domain and login shells do.

## Required launch context

Any Claude Max factory worker on macOS must run where the login keychain is readable: a LaunchAgent in the gui domain, a login Terminal, or `ANTHROPIC_API_KEY` environment authentication. Do not run it from raw tmux.

## LaunchAgent recipe

Create a wrapper that changes to the repository and then replaces itself with the factory process:

```sh
#!/bin/bash
cd /path/to/repo
exec factory run
```

Save this plist as `~/Library/LaunchAgents/com.onpar.factory-<repo>.plist` (adjust all paths and the label):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.onpar.factory-<repo></string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/path/to/wrapper.sh</string>
  </array>
  <key>StandardOutPath</key>
  <string>/path/to/factory.out.log</string>
  <key>StandardErrorPath</key>
  <string>/path/to/factory.err.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
```

Load and start it in the gui domain:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.onpar.factory-<repo>.plist
launchctl kickstart -k gui/$(id -u)/com.onpar.factory-<repo>
```

Stop and unload it with:

```sh
launchctl bootout gui/$(id -u)/com.onpar.factory-<repo>
```

## Verification

From the same launch context, run `factory doctor` and confirm both `claude keychain (macOS)` and `claude auth (host)` pass. Also run:

```sh
claude -p "reply with exactly: ok"
```

## What the factory does

Doctor hard-fails for tmux without keychain access and gives this remediation. `factory run` fails fast in that context before claiming any issue. If `local_auth` occurs mid-run and parks an issue, the factory also emits an `environment_warning` operations event.

## Do not

Do not re-enable Ollama/qwen failover as a workaround. Do not treat issues parked on `local_auth` as product failures; re-queue them after fixing the launch context.

The sandbox-allowlist siblings #1008 and #1009 cover a different failure: the sandbox write allowlist. Factoryd #764 tracks making a launchd wrapper first-class.
