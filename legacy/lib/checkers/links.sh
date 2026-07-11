#!/usr/bin/env bash
# lib/checkers/links.sh — URL/link resolution checker.
#
# Scans HTML output for links and verifies they all resolve.

set -euo pipefail

check_links() {
  local wt="$1" spec="$2" constitution_body="${3:-}"
  local result="PASS" details="" broken=0 checked=0

  cd "$wt" || return 1

  # Find HTML files
  local html_files
  html_files="$(find . -name '*.html' -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null)"

  [ -z "$html_files" ] && {
    jq -n --arg r "PASS" --arg d "no HTML files found — skipped" \
      '{checker: "links", result: $r, details: $d}'
    return 0
  }

  # Extract all href= and src= URLs
  local urls_file; urls_file="$(mktemp)"
  echo "$html_files" | while IFS= read -r f; do
    # Extract href and src values, strip quotes and # anchors
    grep -ohE '(href|src)=["'"'"'][^"'"'"'#]*' "$f" 2>/dev/null \
      | sed -E 's/^(href|src)=["'"'"']//' \
      | sed -E 's/#.*$//' \
      | grep -vE '^(mailto:|tel:|javascript:|data:|$)'
  done | sort -u > "$urls_file"

  checked=$(wc -l < "$urls_file" | tr -d ' ')

  [ "$checked" -eq 0 ] && {
    rm -f "$urls_file"
    jq -n --arg r "PASS" --arg d "no links found in HTML — skipped" \
      '{checker: "links", result: $r, details: $d}'
    return 0
  }

  # Check internal links (relative paths)
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    # Skip absolute URLs for the internal check
    case "$url" in
      http://*|https://*) continue ;;
    esac
    # Resolve relative to the HTML file's directory or repo root
    local target="$url"
    [ -f "$target" ] || [ -d "$target" ] || {
      # Try with index.html
      [ -f "${target%/}/index.html" ] || [ -f "${target}index.html" ] || {
        broken=$((broken+1))
        details="${details}broken: $url; "
      }
    }
  done < "$urls_file"

  # Check external links (optional, can be slow)
  if [ "${CHECK_EXTERNAL_LINKS:-1}" = "1" ]; then
    while IFS= read -r url; do
      case "$url" in
        http://*|https://*) ;;
        *) continue ;;
      esac
      # HEAD request with timeout, follow redirects
      local code
      code="$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 10 "$url" 2>/dev/null || echo "000")"
      if [ "$code" != "200" ] && [ "$code" != "301" ] && [ "$code" != "302" ]; then
        broken=$((broken+1))
        details="${details}external ($code): $url; "
      fi
    done < "$urls_file"
  fi

  rm -f "$urls_file"

  [ "$broken" -gt 0 ] && result="FAIL"

  jq -n --arg r "$result" --arg d "${details:-checked $checked links, all OK}" --argjson b "$broken" --argjson c "$checked" \
    '{checker: "links", result: $r, details: $d, links_checked: $c, broken: $b}'
}