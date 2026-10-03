# ADR-0143: On Windows, killProcessGroup kills a process tree with taskkill /T, graceful first and /F after the grace period

- Status: Accepted
- Date: 2026-10-03

## Context

Lanes spawn checkers and harnesses detached and later kill the whole process group, so dev servers,
build servers and test hosts do not outlive a timed-out command. Windows has no POSIX process groups:
a negative pid does nothing and detached:true does not create a group. Timed-out trees survived there
and held ports and file locks that broke the next run. Windows can only address a tree through a live
root pid, so the order of root kill and tree kill matters.

## Decision

killProcessGroup in packages/core/src/environment/process-groups.ts is the single owner of process-tree
kill on every platform. When the injected or actual platform is win32, it runs `taskkill /T /PID <pid>`,
polls the pid for graceMs, then runs `taskkill /T /F /PID <pid>` if the pid is still alive. Taskkill
exit 128 (or "not found" output) is the `dead` outcome, never an error, and "Access is denied" is
`not-ours`. It never calls the POSIX killFn on win32, and POSIX behavior is unchanged. A caller that
ends a command on Windows must start this tree kill while the root is still alive, not after
child.kill(); runCommandDetached does so on timeout and maxBuffer overflow.

## Consequences

Timed-out trees on Windows are cleaned up through every existing caller (command-runner, exec,
orphan reaping, ProcessGroupTracker) without call-site changes. A Windows timeout can take up to
graceMs longer to report because windowless console processes usually refuse the graceful close.
Descendants of a root that exits during the grace window can still leak, since taskkill cannot find
them once the root is gone; closing that gap would need Job Objects. The Windows path is covered
only by unit tests with an injected platform and taskkill runner, not by a Windows CI runner.

## References

- [taskkill command reference](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)
- [Issue #1908](https://github.com/on-par/software-factory/issues/1908)
