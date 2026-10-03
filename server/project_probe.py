#!/usr/bin/env python3
"""Truthful project status for the HUD.

The defect
----------
`/api/projects` returned `projects.json` verbatim, and the web layer
rendered every entry as `status: 'ACTIVE'`. That is 14 projects claiming
ACTIVE while 6 of their directories no longer exist on disk -- including
`polymarket-profitability-research`, which has no path at all, and
`ui-build`, `ws-build`, `sma-build`, `sma-verify`, `oh-live`,
`openalice-fleet-converge`.

"ACTIVE" here asserts the project is real and being worked on. Nothing
checked either. This is the spec's forbidden pattern: a health state
invented rather than measured.

What is measured
----------------
  MISSING    registry entry whose directory does not exist
  UNKNOWN    directory exists but is not a git repository, so no real
             project activity can be established
  IDLE       a clean git working tree with no branch activity
  ACTIVE     a real git repository, with branch, commit age, and working
             tree state derived from git itself

Every field is read from the filesystem or from git. No field is inferred
from the fact that an entry appears in a registry -- a registered project
is not a running project, and a live directory is not necessarily worked
on.
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

HIVE = os.environ.get("OPENALICE_HIVE") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", ".."
)

# A commit older than this, with a clean tree, means nobody has worked on
# the project recently. It is not "stopped" -- it is idle.
IDLE_COMMIT_AGE_DAYS = 14


def _git(path, *args, timeout=8):
    try:
        out = subprocess.run(
            ["git", "-C", path] + list(args),
            capture_output=True, text=True, timeout=timeout,
        )
        if out.returncode != 0:
            return None
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def _entry_path(item):
    if not isinstance(item, dict):
        return None
    root = item.get("path") or item.get("root")
    if root is None:
        candidates = [
            v for v in item.values()
            if isinstance(v, str) and v.startswith("/")
        ]
        root = candidates[0] if candidates else None
    return root


def _age_days(timestamp):
    if not timestamp:
        return None
    try:
        when = datetime.fromtimestamp(int(timestamp), tz=timezone.utc)
    except (TypeError, ValueError):
        return None
    return (datetime.now(timezone.utc) - when).days


def _is_git_repo(path):
    """Whether `path` is inside a git working tree.

    Asking git is the only honest test. `os.path.isdir(path + "/.git")` is false
    for a linked worktree, where `.git` is a FILE containing `gitdir: <path>`,
    so every worktree was reported as "directory exists but is not a git
    repository" -- status UNKNOWN with branch and head_sha left null, hiding the
    commit history the panel exists to show.

    Measured on /Users/a/trading/openalice-sma, a worktree of the main repo:
        os.path.isdir(path + "/.git")        -> False   <- what the code tested
        os.path.exists(path + "/.git")       -> True
        git rev-parse --is-inside-work-tree  -> true
        git rev-parse --short HEAD           -> a334581

    git answers all three shapes correctly: a normal repository, a linked
    worktree, and a subdirectory of either. Returns a bool; never raises.
    """
    return _git(path, "rev-parse", "--is-inside-work-tree") == "true"


def describe(item):
    """Return a measured record for one registry entry."""
    pid = item.get("id") or item.get("name") or "(unnamed)"
    path = _entry_path(item)

    record = {
        "project_id": pid,
        "name": item.get("name") or pid,
        "path": path,
        "status": "UNKNOWN",
        "reason": "",
        "is_git": False,
        "branch": None,
        "head_sha": None,
        "last_commit_ago": None,
        "dirty_files": None,
        "tracked_files": None,
        "verified": False,
    }

    if not path:
        record["status"] = "MISSING"
        record["reason"] = "registry entry has no path"
        return record

    if not os.path.isdir(path):
        record["status"] = "MISSING"
        record["reason"] = "directory does not exist"
        return record

    record["verified"] = True

    if not _is_git_repo(path):
        record["status"] = "UNKNOWN"
        record["reason"] = "directory exists but is not a git repository"
        return record

    record["is_git"] = True
    record["branch"] = _git(path, "rev-parse", "--abbrev-ref", "HEAD")
    record["head_sha"] = (_git(path, "rev-parse", "--short", "HEAD") or None)
    ts = _git(path, "log", "-1", "--format=%ct")
    record["last_commit_ago"] = _age_days(ts)

    status = _git(path, "status", "--porcelain")
    if status is None:
        record["status"] = "UNKNOWN"
        record["reason"] = "git status failed"
        return record
    changed = [l for l in status.splitlines() if l.strip()]
    record["dirty_files"] = len(changed)

    tracked = _git(path, "ls-files")
    record["tracked_files"] = len(tracked.splitlines()) if tracked is not None else None

    age = record["last_commit_ago"]
    if record["dirty_files"] and record["dirty_files"] > 0:
        record["status"] = "ACTIVE"
        record["reason"] = "%d uncommitted change(s)" % record["dirty_files"]
    elif age is not None and age <= IDLE_COMMIT_AGE_DAYS:
        record["status"] = "ACTIVE"
        record["reason"] = "last commit %dd ago" % age
    else:
        record["status"] = "IDLE"
        record["reason"] = (
            "clean tree, last commit %sd ago" % age if age is not None
            else "clean tree, no commit history"
        )
    return record


def probe():
    projects_file = os.path.join(HIVE, "projects.json")
    try:
        with open(projects_file, encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError) as exc:
        return {
            "projects": [],
            "source": projects_file,
            "error": "projects.json unreadable: %s" % exc,
            "checked_at": int(time.time() * 1000),
        }

    items = raw if isinstance(raw, list) else raw.get("projects", [])
    projects = [describe(i) for i in items if isinstance(i, dict)]

    tally = {}
    for p in projects:
        tally[p["status"]] = tally.get(p["status"], 0) + 1

    return {
        "projects": projects,
        "source": projects_file,
        "summary": tally,
        "missing": [p["project_id"] for p in projects if p["status"] == "MISSING"],
        "checked_at": int(time.time() * 1000),
    }


if __name__ == "__main__":
    print(json.dumps(probe(), indent=2))
