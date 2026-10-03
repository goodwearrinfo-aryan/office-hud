#!/usr/bin/env python3
"""Collect agent sessions, processes, and live shell terminals for the HUD.

Runs on any machine. Writes a single JSON document describing this host so the
office-hud can merge several machines into one view.

Two kinds of "terminal" are reported, deliberately kept apart because they mean
different things and have different lifecycles:

  agent_sessions  Long-lived agent workers, from the fleet hive. These have
                  heartbeats and a lifecycle; they are not shells.
  shell_terminals Actual interactive shells (zsh, bash, fish, tmux, the
                  Terminal.app/iTerm front-ends). These are what a human is
                  actually sitting in, and they have no heartbeat.

Nothing here is destructive and nothing is started; it only reads process state
and the hive. Safe to run on a timer.

Output shape:
  {"host": "...", "collected_at": "...", "agent_sessions": [...],
   "processes": [...], "shell_terminals": [...]}
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

# Shells and terminal front-ends. Kept deliberately narrow: matching every
# process that happens to have a tty would sweep in ssh sessions, editors and
# language servers, which is noise rather than "terminals".
SHELL_PATTERNS = ("zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "tmux")
TERMINAL_APPS = ("Terminal", "iTerm", "WezTerm", "Alacritty", "kitty", "Ghostty")

# Commands worth listing as running work even though they are not shells.
WORK_PATTERNS = (
    "node", "python", "uvicorn", "pytest", "npm", "pnpm", "yarn",
    "openalice", "office_manager", "code-server",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ps() -> List[Dict[str, Any]]:
    """One ps call, parsed once. Returns [] if ps is unavailable."""
    try:
        raw = subprocess.run(
            ["ps", "-Ao", "pid=,ppid=,tty=,etime=,comm=,args="],
            capture_output=True, text=True, timeout=15, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []

    rows: List[Dict[str, Any]] = []
    for line in raw.splitlines():
        parts = line.split(None, 5)
        if len(parts) < 5:
            continue
        pid, ppid, tty, etime, comm = parts[:5]
        args = parts[5] if len(parts) > 5 else comm
        if not pid.strip().isdigit():
            continue
        rows.append({
            "pid": int(pid),
            "ppid": int(ppid) if ppid.strip().isdigit() else 0,
            # "???" means the process has no controlling terminal. Those are
            # daemons, not terminals, and are reported under processes instead.
            "tty": "" if tty.strip() in ("??", "-", "") else tty.strip(),
            "etime": etime.strip(),
            "name": os.path.basename(comm.strip()),
            "command": args.strip()[:400],
        })
    return rows


def _cwd(pid: int) -> str:
    """Working directory of a pid, or '' if it cannot be read.

    This is what makes a shell identifiable: a login shell's argv is literally
    "-zsh", so without its cwd a list of terminals is a wall of identical
    entries. Cheap enough (one lsof, ~7ms) to do per shell on every run.
    """
    try:
        raw = subprocess.run(
            ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
            capture_output=True, text=True, timeout=5, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return ""
    for line in raw.splitlines():
        if line.startswith("n") and len(line) > 1:
            return line[1:]
    return ""


def _classify(procs: List[Dict[str, Any]]) -> tuple:
    by_pid = {p["pid"]: p for p in procs}
    terminals: List[Dict[str, Any]] = []
    processes: List[Dict[str, Any]] = []

    for proc in procs:
        name = proc["name"]
        is_shell = name in SHELL_PATTERNS or any(p in name for p in SHELL_PATTERNS)
        is_app = any(app.lower() == name.lower() for app in TERMINAL_APPS)
        is_work = any(pat in proc["command"] for pat in WORK_PATTERNS)

        if is_app or (is_shell and proc["tty"]):
            parent = by_pid.get(proc["ppid"], {})
            entry = {
                **proc,
                "kind": "terminal-app" if is_app else "shell",
                "parent_name": parent.get("name", ""),
            }
            if not is_app:
                entry["cwd"] = _cwd(proc["pid"])
            terminals.append(entry)
        elif is_work and not is_shell:
            processes.append({
                **proc,
                "kind": "process",
                "status": "RUNNING",
                "observed_at": _now(),
            })

    terminals.sort(key=lambda t: (t["kind"] != "shell", t["pid"]))
    processes.sort(key=lambda p: p["pid"])
    return terminals, processes


# A session whose heartbeat is older than this is not a live session. Matches
# the HUD server's own SESSION_STALE_MS so the two agree on the boundary.
SESSION_STALE_SEC = 300

# Statuses that already mean "not running". Never upgraded: if a record says
# STOPPED it stays STOPPED regardless of how recent its heartbeat looks.
_TERMINAL_STATUS = frozenset({"STOPPED", "DEAD", "ERROR", "FAILED", "STALE"})


def _age_sec(timestamp: Any) -> float:
    """Seconds since an ISO-8601 timestamp. Large if unparseable/absent.

    Returning a large number rather than None means an unparseable or missing
    heartbeat reads as stale, which is the honest answer: a record whose age
    cannot be established is not evidence that anything is running.
    """
    if not isinstance(timestamp, str) or not timestamp:
        return float("inf")
    try:
        moment = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return float("inf")
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - moment).total_seconds()


def _sessions(hive: Path) -> List[Dict[str, Any]]:
    """Read the fleet hive's agent sessions, if this machine runs a fleet.

    A session record is a claim made when it was written, not a measurement of
    now, and this host does not write sessions.json -- it only reads it. So these
    records age indefinitely while still carrying the status they had when last
    written. Measured on this laptop: sessions.json was 71h old and 260 of its
    763 records still declared HEALTHY, with heartbeats up to 3.2 days behind.

    Downgrade anything whose heartbeat is older than SESSION_STALE_SEC to STALE
    and record how old it is, so a stale record can never be published as a live
    one. This only ever downgrades; a record already marked STOPPED/FAILED keeps
    that status, because a fresh heartbeat does not resurrect a dead session.
    """
    path = hive / "sessions.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    sessions = data.get("sessions") if isinstance(data, dict) else None
    if not isinstance(sessions, list):
        return []

    stamped: List[Dict[str, Any]] = []
    for session in sessions:
        if not isinstance(session, dict):
            continue
        age = _age_sec(
            session.get("last_heartbeat") or session.get("updated_at") or session.get("started_at")
        )
        declared = str(session.get("status") or "").upper()
        row = dict(session)
        row["heartbeat_age_sec"] = None if age == float("inf") else int(max(0, age))
        if declared in _TERMINAL_STATUS:
            # Already honestly marked; leave the author's own status alone.
            pass
        elif age > SESSION_STALE_SEC:
            row["status"] = "STALE"
            row["stale_reason"] = (
                "no heartbeat" if age == float("inf")
                else "heartbeat %ds old" % int(age)
            )
        stamped.append(row)
    return stamped


def _processes(hive: Path) -> List[Dict[str, Any]]:
    path = hive / "processes.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    procs = data.get("processes") if isinstance(data, dict) else None
    return procs if isinstance(procs, list) else []


def collect(hive: Path) -> Dict[str, Any]:
    terminals, live_processes = _classify(_ps())
    return {
        "host": socket.gethostname().split(".")[0],
        "fqn": socket.getfqdn(),
        "collected_at": _now(),
        "agent_sessions": _sessions(hive),
        # Observe first, fall back to the cache only when observation yields
        # nothing. The other order lets hive/processes.json shadow the live scan
        # whenever that file is non-empty, and nothing rewrites it, so it freezes
        # at whatever it held and every record in it keeps claiming RUNNING.
        "processes": live_processes or _processes(hive),
        "shell_terminals": terminals,
    }


def main(argv: List[str]) -> int:
    hive = Path(
        argv[1] if len(argv) > 1
        else os.environ.get("OFFICE_HUD_HIVE")
        or os.path.expanduser("~/openalice-fleet/hive")
    )
    payload = collect(hive)

    if len(argv) > 2 and argv[2] == "--print":
        json.dump(payload, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    out = hive / "terminals.json"
    tmp = out.with_suffix(".json.tmp")
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        # Write-then-rename so a reader never sees a half-written document.
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, out)
    except OSError as exc:
        print(f"could not write {out}: {exc}", file=sys.stderr)
        return 1

    print(
        f"{payload['host']}: {len(payload['agent_sessions'])} agent session(s), "
        f"{len(payload['processes'])} process(es), "
        f"{len(payload['shell_terminals'])} terminal(s) -> {out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
