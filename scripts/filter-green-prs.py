#!/usr/bin/env python3
"""Select factory PRs ready to land through the sweep.

Reads the JSON array from `gh pr list` on stdin. Eligible PRs are printed as
"<number>\t<closing issue>\t<gated>"; rejected PRs are described on stderr.
"""
import json
import os
import sys

GATE_LABEL = os.environ.get("GATE_LABEL") or "no-auto-merge"
BRANCH_PREFIX = os.environ.get("BRANCH_PREFIX") or "factory/"


def closing_issue(pr):
    refs = pr.get("closingIssuesReferences") or []
    numbers = []
    for ref in refs:
        number = ref["number"]
        if not isinstance(number, int) or isinstance(number, bool) or number < 1:
            raise ValueError("closing issue number must be a positive integer")
        numbers.append(str(number))
    return ",".join(dict.fromkeys(numbers))


def landability_reason(pr):
    if pr.get("isDraft"):
        return "draft PR"
    if pr.get("mergeable") != "MERGEABLE":
        return f"mergeable state is {pr.get('mergeable') or 'missing'}"
    checks = pr.get("statusCheckRollup") or []
    if not checks:
        return "no status checks"
    states = {check.get("conclusion") or check.get("state") for check in checks}
    if states != {"SUCCESS"}:
        return "checks are not all SUCCESS"

    head = pr.get("headRefName")
    if not isinstance(head, str) or not head.startswith(BRANCH_PREFIX):
        return f"not a factory branch (expected prefix {BRANCH_PREFIX})"

    try:
        issue_numbers = closing_issue(pr)
    except (KeyError, TypeError, ValueError):
        return "invalid closing issue references"
    if not issue_numbers:
        return "closes no issue"
    if "," in issue_numbers:
        return f"closes multiple issues (#{issue_numbers.replace(',', ', #')})"
    return None


def is_landable(pr):
    return landability_reason(pr) is None


def pr_gated(pr, label):
    return any((entry or {}).get("name") == label for entry in (pr.get("labels") or []))


def main():
    raw = sys.stdin.read()
    prs = json.loads(raw) if raw.strip() else []
    for pr in prs:
        reason = landability_reason(pr)
        if reason:
            print(f"SKIPPING PR #{pr.get('number', '?')}: {reason}", file=sys.stderr)
            continue
        gated = "gated" if pr_gated(pr, GATE_LABEL) else ""
        print(f"{pr['number']}\t{closing_issue(pr)}\t{gated}")


if __name__ == "__main__":
    main()
