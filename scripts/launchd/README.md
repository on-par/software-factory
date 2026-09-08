# launchd: auto-merge-sweep LaunchAgent

## Install

```bash
scripts/launchd/install-sweep-plist.sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.on-par.auto-merge-sweep.plist
```

The first line renders `com.on-par.auto-merge-sweep.plist.template` with this
machine's repo root and home directory and writes the result to
`~/Library/LaunchAgents/com.on-par.auto-merge-sweep.plist`. It does **not**
load the agent — run the second line (`launchctl bootstrap`) to load it.
