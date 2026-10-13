# Shared helpers for the fake agent CLI shims. Sourced, not executed.
# Callers set FAKE_AGENTS_DIR to the scripts/fixtures/agents directory first.

fake_mode() {
  mode="${FAKE_AGENT_MODE:-success}"
  case "$mode" in
    success | rate-limit | usage-cap | empty) echo "$mode" ;;
    *)
      echo "fake-agent: unknown FAKE_AGENT_MODE '$mode' (expected success|rate-limit|usage-cap|empty)" >&2
      exit 2
      ;;
  esac
}

fake_replay() {
  cat "$FAKE_AGENTS_DIR/recordings/$1/$2.stdout"
  if [ -f "$FAKE_AGENTS_DIR/recordings/$1/$2.stderr" ]; then
    cat "$FAKE_AGENTS_DIR/recordings/$1/$2.stderr" >&2
  fi
}

fake_commit() {
  mkdir -p "$2/fake-agent-output"
  echo "$1 fake success" >"$2/fake-agent-output/$1-$(date +%s)-$$.txt"
  git -C "$2" add -A
  git -C "$2" -c user.name=fake-agent -c user.email=fake-agent@example.invalid commit -q -m "$1: fake success"
}

fake_drain_stdin() {
  [ -t 0 ] || cat >/dev/null
}
