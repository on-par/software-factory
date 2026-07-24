#!/usr/bin/env python3
"""Filter `gh pr list --json number,isDraft,mergeable,statusCheckRollup,closingIssuesReferences`
output down to landable PRs: open, non-draft, MERGEABLE, with at least one CI check and
every check SUCCESS. Reads the JSON array on stdin; prints one line per landable PR:
"<number>\t<comma-joined closing issue numbers>" (issue field empty for standalone PRs).
Used by scripts/auto-merge-sweep.sh."""
import json
import sys


def is_landable(pr):
    if pr["isDraft"]:
        return False
    if pr.get("mergeable") != "MERGEABLE":
        return False
    checks = pr.get("statusCheckRollup") or []
    if not checks:
        return False
    states = {c.get("conclusion") or c.get("state") for c in checks}
    return states == {"SUCCESS"}


def closing_issue(pr):
    refs = pr.get("closingIssuesReferences") or []
    return ",".join(dict.fromkeys(str(r["number"]) for r in refs))


def main():
    raw = sys.stdin.read()
    prs = json.loads(raw) if raw.strip() else []
    for pr in prs:
        if not is_landable(pr):
            continue
        print(f"{pr['number']}\t{closing_issue(pr)}")


if __name__ == "__main__":
    main()
