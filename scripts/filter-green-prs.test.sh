#!/usr/bin/env bash
# Unit test for scripts/filter-green-prs.py: the "which PRs are landable" policy,
# exercised against fixture JSON piped on stdin.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILTER="$ROOT/scripts/filter-green-prs.py"

run_filter() { python3 "$FILTER"; }

assert_eq() { # assert_eq "<label>" "<expected>" "<actual>"
  if [ "$2" != "$3" ]; then
    printf 'FAIL: %s\nexpected: %q\nactual:   %q\n' "$1" "$2" "$3" >&2
    exit 1
  fi
}

# 1. Landable PR with one closing issue
actual="$(run_filter <<'JSON'
[{"number": 102, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": [{"number": 42}]}]
JSON
)"
expected="$(printf '102\tabc123\t42')"
assert_eq "landable PR with one closing issue" "$expected" "$actual"

# 2. Standalone landable PR (no closing issues) — trailing tab must survive
actual="$(run_filter <<'JSON'
[{"number": 101, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []}]
JSON
)"
expected="$(printf '101\tabc123\t')"
assert_eq "standalone landable PR" "$expected" "$actual"

# 3. Draft PR => skipped
actual="$(run_filter <<'JSON'
[{"number": 200, "isDraft": true, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []}]
JSON
)"
assert_eq "draft PR skipped" "" "$actual"

# 4. mergeable CONFLICTING and UNKNOWN => skipped
actual="$(run_filter <<'JSON'
[
  {"number": 201, "isDraft": false, "mergeable": "CONFLICTING", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []},
  {"number": 202, "isDraft": false, "mergeable": "UNKNOWN", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []}
]
JSON
)"
assert_eq "non-mergeable PRs skipped" "" "$actual"

# 5. Missing mergeable key => skipped
actual="$(run_filter <<'JSON'
[{"number": 203, "isDraft": false, "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []}]
JSON
)"
assert_eq "missing mergeable key skipped" "" "$actual"

# 6. Empty statusCheckRollup [] and null => skipped
actual="$(run_filter <<'JSON'
[
  {"number": 204, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [], "closingIssuesReferences": []},
  {"number": 205, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": null, "closingIssuesReferences": []}
]
JSON
)"
assert_eq "no checks skipped" "" "$actual"

# 7. Mixed check states => skipped
actual="$(run_filter <<'JSON'
[
  {"number": 206, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}, {"conclusion": "FAILURE"}], "closingIssuesReferences": []},
  {"number": 207, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}, {"state": "PENDING"}], "closingIssuesReferences": []}
]
JSON
)"
assert_eq "mixed check states skipped" "" "$actual"

# 8. StatusContext-style checks (state, no conclusion) => landable
actual="$(run_filter <<'JSON'
[{"number": 208, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [{"state": "SUCCESS"}], "closingIssuesReferences": []}]
JSON
)"
expected="$(printf '208\tabc123\t')"
assert_eq "StatusContext-style checks landable" "$expected" "$actual"

# 9. Multi-issue PR — comma-joined, order-preserving dedup
actual="$(run_filter <<'JSON'
[{"number": 103, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": [{"number": 55}, {"number": 56}, {"number": 55}]}]
JSON
)"
expected="$(printf '103\tabc123\t55,56')"
assert_eq "multi-issue PR dedup" "$expected" "$actual"

# 10. Empty stdin => empty output, exit 0
actual="$(printf '' | run_filter)"
assert_eq "empty stdin" "" "$actual"

# 11. Empty array => empty output, exit 0
actual="$(run_filter <<'JSON'
[]
JSON
)"
assert_eq "empty array" "" "$actual"

# 12. Mixed fixture — draft, conflicting, checkless, and two landable PRs, in input order
actual="$(run_filter <<'JSON'
[
  {"number": 300, "isDraft": true, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []},
  {"number": 301, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": [{"number": 10}]},
  {"number": 302, "isDraft": false, "mergeable": "CONFLICTING", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []},
  {"number": 303, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [], "closingIssuesReferences": []},
  {"number": 304, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []}
]
JSON
)"
expected="$(printf '301\tabc123\t10\n304\tabc123\t')"
assert_eq "mixed fixture, input order" "$expected" "$actual"

# 13. All present checks green but mergeStateStatus not CLEAN (a required check has not
#     reported yet, review pending, behind base, unknown, or the key is missing) => skipped
actual="$(run_filter <<'JSON'
[
  {"number": 401, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "BLOCKED", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []},
  {"number": 402, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "UNSTABLE", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []},
  {"number": 403, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "BEHIND", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []},
  {"number": 404, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "UNKNOWN", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []},
  {"number": 405, "isDraft": false, "mergeable": "MERGEABLE", "headRefOid": "abc123", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []}
]
JSON
)"
assert_eq "non-CLEAN mergeStateStatus skipped" "" "$actual"

# 14. Missing or empty headRefOid => skipped (the merge could not be pinned)
actual="$(run_filter <<'JSON'
[
  {"number": 406, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []},
  {"number": 407, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefOid": "", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []}
]
JSON
)"
assert_eq "missing headRefOid skipped" "" "$actual"

# 15. The emitted head SHA is the PR's own headRefOid
actual="$(run_filter <<'JSON'
[{"number": 408, "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "headRefOid": "0123456789abcdef0123456789abcdef01234567", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": [{"number": 9}]}]
JSON
)"
expected="$(printf '408\t0123456789abcdef0123456789abcdef01234567\t9')"
assert_eq "headRefOid emitted per PR" "$expected" "$actual"

echo "PASS: filter-green-prs correctly identifies landable PRs (draft/mergeable/mergeStateStatus CLEAN/headRefOid/checks rules), emits each PR's head SHA, joins closing issues with order-preserving dedup, and handles empty/whitespace stdin"
