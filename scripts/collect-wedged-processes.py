#!/usr/bin/env python3
"""collect-wedged-processes - one-shot tool invocations that never finished.

THE PROBLEM, CONCRETELY. On 2026-09-30 two quality-gate runs were found alive
after four hours. The gate had printed its final verdict and then never exited:
run_command() in scripts/run_quality_gate.py passes no timeout, so the Python
parent parked in poll() waiting for a `node --test` child that will never exit.
sample showed the children holding KQUEUE/PIPE/unix sockets at 0:00.03 CPU with
the output log frozen across a 20 second sample, and two true orphans still
running a test file that had been deleted from disk.

audit_orphan_daemons.py reads a different axis: processes that no launchd job
owns. It caught the two orphans and missed the six still parented by a live
shell, because a live session counts as ownership. This collector is the other
lens: processes that look like one-shot tool invocations - a gate run, a test
suite, a typecheck - that have been running for hours. Those are supposed to
take minutes. One that does not is wedged, whoever owns it.

Patterns are kept deliberately narrow, the same discipline collect-terminals.py
applies to shells: matching every long-running process would sweep in servers
and daemons that are supposed to run forever, which is noise rather than
"wedged".

Output shape (one JSON document, same convention as collect-terminals.py):

    {"host": "...", "collected_at": "...", "wedged": [...], "totals": {...}}

Each finding reports the highest wedged process in its tree plus every
descendant, so one accident reads as one finding, and resolves the command's
script path against the process cwd so a deleted file shows up as
unreproducible rather than invisible.

Nothing here is destructive and nothing is started or killed. It only reads
process state, and it exits after writing - a one-shot by construction, because
the orphan-daemon lesson is that a diagnostic whose default mode is a watch
loop becomes a daemon nobody owns.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Set

# One-shot tools. A gate run, a test suite, a linter or a typecheck is supposed
# to finish. Kept deliberately narrow: this list is about tools that terminate,
# so anything that is a server by design does not belong on it.
ONESHOT_PATTERNS = (
    "run_quality_gate.py",
    "pytest",
    "node --test",
    ".test.js",
    ".test.ts",
    "pyright",
    "ruff",
    "mypy",
    "tsc",
    "jest",
)

DEFAULT_MIN_SECONDS = 1800  # a one-shot over 30 minutes is not making progress


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _etime_seconds(raw: str) -> int:
    """macOS etime: [[dd-]hh:]mm:ss -> seconds. 0 when unparseable."""
    try:
        text = raw.strip()
        days = 0
        if "-" in text:
            d, text = text.split("-", 1)
            days = int(d)
        parts = [int(p) for p in text.split(":")]
        if len(parts) == 2:
            return days * 86400 + parts[0] * 60 + parts[1]
        if len(parts) == 3:
            return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]
    except (ValueError, AttributeError):
        pass
    return 0


def _cpu_seconds(raw: str) -> float:
    """macOS TIME= as mm:ss.cc (or hh:mm:ss.cc) -> seconds. 0 when unparseable."""
    try:
        parts = raw.strip().split(":")
        sec = float(parts[-1])
        minutes = int(parts[-2]) if len(parts) > 1 else 0
        hours = int(parts[-3]) if len(parts) > 2 else 0
        return hours * 3600 + minutes * 60 + sec
    except (ValueError, IndexError):
        return 0.0


def _ps() -> List[Dict[str, Any]]:
    """One ps call, parsed once, with a timeout. Returns [] when unavailable.

    The timeout is not optional: the defect that motivated this collector is a
    subprocess call with none, and a diagnostic that can hang is part of the
    problem it reports.
    """
    try:
        out = subprocess.run(
            ["ps", "-Ao", "pid=,ppid=,pgid=,etime=,time=,state=,comm=,args="],
            capture_output=True, text=True, timeout=15, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    rows: List[Dict[str, Any]] = []
    for line in out.splitlines():
        parts = line.split(None, 7)
        if len(parts) < 7:
            continue
        pid, ppid, pgid, etime, cputime, state = parts[:6]
        args = parts[7] if len(parts) > 7 else parts[6]
        if not pid.strip().isdigit():
            continue
        rows.append({
            "pid": int(pid),
            "ppid": int(ppid) if ppid.strip().isdigit() else 0,
            "pgid": int(pgid) if pgid.strip().isdigit() else 0,
            "etime": etime.strip(),
            "cpu_time": cputime.strip(),
            "state": state.strip(),
            "command": args.strip()[:400],
        })
    return rows


def _cwd(pid: int) -> str:
    """Working directory of a pid, or '' when it cannot be read."""
    try:
        out = subprocess.run(
            ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
            capture_output=True, text=True, timeout=10, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return ""
    for line in out.splitlines():
        if line.startswith("n/"):
            return line[1:]
    return ""


def _launchd_pids() -> Set[int]:
    """Pids launchd currently manages, or an empty set when unavailable."""
    try:
        out = subprocess.run(
            ["launchctl", "list"], capture_output=True, text=True,
            timeout=15, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return set()
    pids: Set[int] = set()
    for line in out.splitlines():
        first = line.split("\t")[0].strip()
        if first.isdigit():
            pids.add(int(first))
    return pids


def _script_path(command: str, cwd: str):
    """The script the command runs, resolved against the cwd.

    argv[0] is the interpreter - `/Users/a/.nvm/.../bin/node` or a venv python -
    and naming it would report the binary rather than the thing being run, which
    always exists and so would make every finding look reproducible. Script
    extensions win over generic path tokens for that reason. This is also what
    makes a deleted file visible: `node lib/x/y.test.js` ran from a directory
    that no longer contains that file, and without the cwd the path is a bare
    relative string nobody can check.
    """
    fallback = ""
    for token in command.split():
        if token.endswith((".py", ".js", ".ts", ".mjs", ".cjs")):
            candidate = Path(token)
            if not candidate.is_absolute() and cwd:
                candidate = Path(cwd) / candidate
            try:
                return str(candidate), candidate.exists()
            except OSError:
                return str(candidate), False
        if not fallback and "/" in token:
            fallback = token
    if fallback:
        candidate = Path(fallback)
        if not candidate.is_absolute() and cwd:
            candidate = Path(cwd) / candidate
        try:
            return str(candidate), candidate.exists()
        except OSError:
            return str(candidate), False
    return "", True


def _is_wedged(row: Dict[str, Any], min_seconds: int) -> bool:
    command = row["command"]
    if not any(p in command for p in ONESHOT_PATTERNS):
        return False
    return _etime_seconds(row["etime"]) >= min_seconds


def _tree(root_pid: int, rows: List[Dict[str, Any]], wedged_pids: Set[int]) -> List[Dict[str, Any]]:
    """root plus every descendant, so one accident reads as one finding."""
    by_ppid: Dict[int, List[Dict[str, Any]]] = {}
    for r in rows:
        by_ppid.setdefault(r["ppid"], []).append(r)
    members = [r for r in rows if r["pid"] == root_pid]
    frontier = [root_pid]
    while frontier:
        nxt: List[Dict[str, Any]] = []
        for p in frontier:
            for child in by_ppid.get(p, []):
                members.append(child)
                nxt.append(child["pid"])
        frontier = nxt
    seen: Set[int] = set()
    unique = []
    for m in members:
        if m["pid"] not in seen:
            seen.add(m["pid"])
            unique.append(m)
    return unique


def collect(min_seconds: int) -> Dict[str, Any]:
    rows = _ps()
    wedged = [r for r in rows if _is_wedged(r, min_seconds)]
    wedged_pids = {r["pid"] for r in wedged}
    roots = [r for r in wedged if r["ppid"] not in wedged_pids]
    launchd = _launchd_pids()

    findings: List[Dict[str, Any]] = []
    for root in roots:
        members = _tree(root["pid"], rows, wedged_pids)
        script, exists = _script_path(root["command"], _cwd(root["pid"]))
        findings.append({
            "pid": root["pid"],
            "ppid": root["ppid"],
            "pgid": root["pgid"],
            "etime": root["etime"],
            "elapsed_seconds": _etime_seconds(root["etime"]),
            "cpu_time": root["cpu_time"],
            "cpu_seconds": round(_cpu_seconds(root["cpu_time"]), 3),
            "state": root["state"],
            "command": root["command"],
            "script_path": script,
            "script_exists": exists,
            "managed_by_launchd": root["pid"] in launchd,
            "tree": [
                {"pid": m["pid"], "ppid": m["ppid"], "etime": m["etime"],
                 "cpu_time": m["cpu_time"], "wedged": m["pid"] in wedged_pids,
                 "command": m["command"][:160]}
                for m in members
            ],
        })

    findings.sort(key=lambda f: -f["elapsed_seconds"])
    return {
        "host": socket.gethostname(),
        "collected_at": _now(),
        "wedged": findings,
        "totals": {
            "processes_seen": len(rows),
            "wedged_processes": len(wedged),
            "wedged_roots": len(findings),
            "min_seconds": min_seconds,
        },
    }


def main() -> int:
    hive = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("hive")
    min_seconds = DEFAULT_MIN_SECONDS
    for arg in sys.argv[2:]:
        if arg.startswith("--min-seconds="):
            try:
                min_seconds = int(arg.split("=", 1)[1])
            except ValueError:
                pass
    if not hive.is_dir():
        print(f"wedged collector: hive dir {hive} does not exist, writing nothing",
              file=sys.stderr)
        return 1
    doc = collect(min_seconds)
    out = hive / "wedged.json"
    tmp = hive / ".wedged.json.tmp"
    tmp.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n")
    os.replace(tmp, out)
    print(f"wedged collector: {doc['totals']['wedged_roots']} wedged roots "
          f"across {doc['totals']['wedged_processes']} processes -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
