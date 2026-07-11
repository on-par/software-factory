#!/usr/bin/env bash
# lib/models.sh — Model registry loader and cost calculations.
# Reads config/models.json and provides functions to list, resolve, and
# cost models. Sourced by router.sh and the factory CLI.

set -euo pipefail

MODELS_FILE="${FACTORY_MODELS_FILE:-$(dirname "$(dirname "${BASH_SOURCE[0]}")")/config/models.json}"

# Load the models JSON. Returns raw JSON on stdout.
_models_json() { jq -c '.' "$MODELS_FILE" 2>/dev/null || echo '{}'; }

# List all model IDs.
models_list() { jq -r '.models | keys[]' "$MODELS_FILE"; }

# Get a model property: models_get <model_id> <property>
models_get() { jq -r --arg m "$1" --arg k "$2" '.models[$m][$k] // empty' "$MODELS_FILE"; }

# Get the tier(s) for a model (may be array or string).
models_tier() { jq -r --arg m "$1" '.models[$m].tier | if type=="array" then .[] else . end' "$MODELS_FILE"; }

# Check if a model's env key is present (BYOK mode).
models_env_available() {
  local key; key="$(models_get "$1" env_key)"
  [ -z "$key" ] && return 0   # null env_key = local/free (Ollama)
  [ -n "${!key:-}" ]
}

# Get models in a tier, in priority order.
models_in_tier() { jq -r --arg t "$1" '.tiers[$t][] // empty' "$MODELS_FILE"; }

# Estimate cost for a model given token counts: models_cost <model_id> <input_tokens> <output_tokens>
models_cost() {
  local model="$1" input="$2" output="$3"
  local in_cost out_cost
  in_cost="$(models_get "$model" cost_per_mtok_input)"
  out_cost="$(models_get "$model" cost_per_mtok_output)"
  in_cost="${in_cost:-0}"; out_cost="${out_cost:-0}"
  # tokens → millions → cost
  awk -v i="$input" -v o="$output" -v ic="$in_cost" -v oc="$out_cost" \
    'BEGIN { printf "%.4f\n", (i/1000000)*ic + (o/1000000)*oc }'
}

# Check if Codex CLI is available for a model.
models_is_codex() { [ "$(models_get "$1" codex)" = "true" ]; }

# Get the claude -p flag for a model.
models_claude_flag() { models_get "$1" claude_flag; }

# Get codex flags for a model.
models_codex_flag() { models_get "$1" codex_flag; }

# Check if a model is available (env key present, codex on PATH if needed).
models_available() {
  models_env_available "$1" || return 1
  if models_is_codex "$1" && ! command -v codex >/dev/null 2>&1; then
    return 1
  fi
  return 0
}