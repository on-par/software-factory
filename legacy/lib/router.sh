#!/usr/bin/env bash
# lib/router.sh — Model router with cost-tier routing and automatic failover.
#
# The router resolves a task type (e.g., "plan", "build_claude", "check_tests")
# to a specific model by:
#   1. Looking up the task's tier from config/routes.json
#   2. Walking the tier's model list (from config/models.json) in priority order
#   3. Skipping models that aren't available (no env key, no codex binary)
#   4. On failure (rate limit, timeout, error), failing over to the next model
#
# Sourced by the factory CLI. All functions echo results on stdout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FACTORY_ROOT="$(dirname "$SCRIPT_DIR")"

# Source dependencies.
# shellcheck source=models.sh
[ -f "$SCRIPT_DIR/models.sh" ] && . "$SCRIPT_DIR/models.sh"

ROUTES_FILE="${FACTORY_ROUTES_FILE:-$FACTORY_ROOT/config/routes.json}"

# Resolve a task type to its tier: router_tier <task_type>
router_tier() { jq -r --arg t "$1" '.routes[$t].tier // empty' "$ROUTES_FILE"; }

# Check if a task type requires Codex: router_requires_codex <task_type>
router_requires_codex() { jq -r --arg t "$1" '.routes[$t].requires // empty' "$ROUTES_FILE" | grep -qi codex; }

# Resolve a task type to the first available model: router_resolve <task_type>
# Walks the tier's model list, returns the first available model.
# If BYOK mode is active (FACTORY_BYOK=1), skips models without env keys.
router_resolve() {
  local task="$1" tier model
  tier="$(router_tier "$task")"
  [ -z "$tier" ] && { echo "ERROR: no tier for task '$task'" >&2; return 1; }

  while IFS= read -r model; do
    [ -z "$model" ] && continue
    # In BYOK mode, skip models without env keys
    if [ "${FACTORY_BYOK:-0}" = "1" ] && ! models_env_available "$model"; then
      continue
    fi
    # Check availability (env key + codex binary if needed)
    if models_available "$model"; then
      echo "$model"
      return 0
    fi
  done < <(models_in_tier "$tier")

  echo "ERROR: no available model for task '$task' (tier: $tier)" >&2
  return 1
}

# Resolve with fallback list: router_resolve_all <task_type>
# Echoes all available models for the task, in priority order (for failover chains).
router_resolve_all() {
  local task="$1" tier model
  tier="$(router_tier "$task")"
  [ -z "$tier" ] && return 1

  while IFS= read -r model; do
    [ -z "$model" ] && continue
    if [ "${FACTORY_BYOK:-0}" = "1" ] && ! models_env_available "$model"; then
      continue
    fi
    if models_available "$model"; then
      echo "$model"
    fi
  done < <(models_in_tier "$tier")
}

# Detect failure type from a command's stderr/stdout.
# Echoes one of: rate_limit, usage_cap, timeout, error, empty_response, unknown
# router_classify_failure <stderr_text> <exit_code>
router_classify_failure() {
  local text="$1" rc="$2"
  [ "$rc" -eq 124 ] && { echo "timeout"; return 0; }
  echo "$text" | grep -qiE 'rate.?limit|429|too many requests' && { echo "rate_limit"; return 0; }
  echo "$text" | grep -qiE 'usage.?limit|quota|billing|insufficient|credit' && { echo "usage_cap"; return 0; }
  echo "$text" | grep -qiE 'empty|no content|no response' && { echo "empty_response"; return 0; }
  echo "$text" | grep -qiE 'error|fail|exception' && { echo "error"; return 0; }
  echo "unknown"
}

# Run a model with failover: router_run <task_type> <prompt> <output_file> [model_override]
# Tries the resolved model; on failure, classifies and fails over to the next model.
# Echoes the model that succeeded (for cost tracking).
# Returns non-zero if all models in the tier fail.
router_run() {
  local task="$1" prompt="$2" output="$3" override="${4:-}"
  local models model rc stderr_text failure_type retries

  if [ -n "$override" ]; then
    models="$override"
  else
    models="$(router_resolve_all "$task")"
  fi

  [ -z "$models" ] && { echo "ERROR: no models available for task '$task'" >&2; return 1; }

  local max_retries
  max_retries="$(jq -r '.failover.max_retries // 2' "$MODELS_FILE")"
  local cooldown_ms
  cooldown_ms="$(jq -r '.failover.cooldown_ms // 5000' "$MODELS_FILE")"

  while IFS= read -r model; do
    [ -z "$model" ] && continue
    retries=0
    while [ "$retries" -le "$max_retries" ]; do
      stderr_text=""
      log_event "router" "-" "trying $model for $task (attempt $((retries+1)))"

      if models_is_codex "$model" && router_requires_codex "$task"; then
        # Codex route
        local prompt_file; prompt_file="$(mktemp)"
        printf '%s' "$prompt" > "$prompt_file"
        stderr_text="$(timeout "${FACTORY_BUILD_TIMEOUT:-7200}" \
          codex exec --yolo -C "${WT:-$(pwd)}" \
            $(models_codex_flag "$model") \
            -o "$output" - <"$prompt_file" 2>&1 || true)"
        rc=$?
        rm -f "$prompt_file"
      else
        # Claude route
        local flag; flag="$(models_claude_flag "$model")"
        stderr_text="$(timeout "${FACTORY_PHASE_TIMEOUT:-1800}" \
          claude -p "$prompt" $flag --dangerously-skip-permissions \
          > "$output" 2>&1 || true)"
        rc=$?
      fi

      # Check for success
      if [ "$rc" -eq 0 ] && [ -s "$output" ]; then
        # Check for empty response
        if ! grep -qE '[a-zA-Z0-9]' "$output"; then
          failure_type="empty_response"
        else
          echo "$model"
          return 0
        fi
      else
        failure_type="$(router_classify_failure "$stderr_text" "$rc")"
      fi

      log_event "router" "-" "$model failed ($failure_type, rc=$rc) on $task"

      # Rate limit → retry with cooldown
      if [ "$failure_type" = "rate_limit" ] && [ "$retries" -lt "$max_retries" ]; then
        retries=$((retries+1))
        local cooldown_sec=$((cooldown_ms / 1000))
        log_event "router" "-" "rate limited — cooldown ${cooldown_sec}s before retry"
        sleep "$cooldown_sec"
        continue
      fi

      # Usage cap / quota → failover immediately to next model
      if [ "$failure_type" = "usage_cap" ]; then
        log_event "router" "-" "usage cap hit on $model — failing over to next model"
        break
      fi

      # Timeout → failover
      if [ "$failure_type" = "timeout" ]; then
        log_event "router" "-" "$model timed out on $task — failing over"
        break
      fi

      # Generic error → retry once, then failover
      if [ "$failure_type" = "error" ] && [ "$retries" -lt 1 ]; then
        retries=$((retries+1))
        continue
      fi

      # Empty response → failover
      break
    done
  done < <(echo "$models")

  echo "ERROR: all models failed for task '$task'" >&2
  return 1
}