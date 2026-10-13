# Assertion for the claude sentinel (sentinel/claude). Sourced, not executed.
# claude_sentinel_check <log>: returns 0 when the log is missing or empty,
# otherwise prints the recorded calls to stderr and returns 1.

claude_sentinel_check() {
  if [ -s "$1" ]; then
    echo "claude sentinel: claude was invoked during the smoke run:" >&2
    cat "$1" >&2
    return 1
  fi
  return 0
}
