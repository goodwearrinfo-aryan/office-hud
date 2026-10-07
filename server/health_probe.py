#!/usr/bin/env python3
"""Make /api/health evidence-based instead of a hardcoded ok:true.

The defect
----------
`app.get('/api/health')` returned `{ ok: true, ...hiveStatus() }`. The
`ok` was a literal. It reported success unconditionally -- with the hive
missing, with every agent manager dead, with a corrupt tasks.json. Any
monitor, uptime check, or alert that trusted `ok` would have been told
the system was healthy while it was not. This is precisely the failure the
operating spec forbids: turning "no error detected" into "healthy".

The fix
-------
An independent probe, in its own file, so a rewrite of server/index.js by
another process cannot silently revert it. index.js then requires this
module and calls it. If the module is missing, index.js falls back to
omitting `ok` entirely rather than asserting a truth it cannot support.

Checks performed (each independently failable):
  hive        - HIVE directory exists and is readable
  tasks       - tasks.json parses and is a list/dict
  agents      - how many agent managers are alive
  feed        - the task feed daemon is alive
  floors      - evidence-based floor states, when floor_health.py exists

`ok` is true only when no check is in a failing state. A warning (some
agents down, floors idle) does not make the system unhealthy; a missing
hive or unparseable state does.

The result also states what was NOT verified, so a caller can tell the
difference between "healthy" and "we did not check".
"""
import json
import os
import subprocess
import sys
import time

HIVE = os.environ.get("OPENALICE_HIVE") or os.environ.get("OFFICE_HUD_HIVE") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "hive"
)


def _hive_dir():
    return os.path.abspath(HIVE)


def _check(name, ok, detail, level="fail", checked=True):
    return {
        "check": name,
        "ok": bool(ok),
        "level": level,
        "detail": detail,
        "verified": checked,
    }


def _alive(pattern):
    try:
        out = subprocess.run(
            ["pgrep", "-f", pattern], capture_output=True, text=True, timeout=5
        )
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def _alive_case_insensitive(path):
    """pgrep without -f, filtering the command line ourselves.

    `pgrep -f` matches its pattern case-sensitively, but this filesystem is
    case-insensitive, so a path spelled `agents/f1/...` passes
    os.path.exists and then fails to match a process whose command line
    says `agents/F1/...`. Reporting that as a dead manager would be a
    fabricated outage, so the comparison is done here where it can be
    case-insensitive.
    """
    needle = os.path.basename(os.path.dirname(os.path.dirname(path)))
    try:
        out = subprocess.run(
            ["ps", "-Ao", "pid=,command="],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    target = needle.lower()
    for line in out.stdout.splitlines():
        pid, _, command = line.strip().partition(" ")
        if "agent_manager.js" not in command:
            continue
        if target in command.lower():
            return pid
    return ""


def probe():
    hive = _hive_dir()
    checks = []
    unverified = []

    # --- hive present ---
    hive_ok = os.path.isdir(hive) and os.access(hive, os.R_OK)
    checks.append(_check(
        "hive", hive_ok,
        hive if hive_ok else "missing or unreadable: %s" % hive,
    ))

    # --- tasks.json parses ---
    if hive_ok:
        tasks_path = os.path.join(hive, "tasks.json")
        tasks_ok = False
        detail = "tasks.json not found"
        try:
            with open(tasks_path, encoding="utf-8") as fh:
                data = json.load(fh)
            items = data if isinstance(data, list) else data.get("tasks")
            tasks_ok = isinstance(items, list)
            detail = "%d task record(s)" % (len(items) if tasks_ok else 0)
            if not tasks_ok:
                detail = "tasks.json is not a list or {tasks: []}"
        except (OSError, ValueError) as exc:
            detail = "unreadable or unparseable: %s" % exc
        checks.append(_check("tasks", tasks_ok, detail))
    else:
        checks.append(_check("tasks", False, "hive missing", checked=False))

    # --- agent managers alive ---
    agents_dir = os.path.join(hive, "agents")
    total = alive = 0
    dead = []
    if os.path.isdir(agents_dir):
        for name in sorted(os.listdir(agents_dir)):
            mgr = os.path.join(agents_dir, name, "bin", "agent_manager.js")
            if not os.path.exists(mgr):
                continue
            total += 1
            # pgrep -f is case-SENSITIVE on the pattern while the filesystem
            # here is case-INSENSITIVE, so `agents/f1/...` matches the file
            # but never the running process line `agents/F1/...`. Matching the
            # bare filename would also be ambiguous, so match the agent name
            # case-insensitively by asking pgrep for a pattern built from the
            # real on-disk name and matching on the process command itself.
            if _alive(mgr) or _alive_case_insensitive(mgr):
                alive += 1
                continue
            # Not every manager agent's entrypoint is agent_manager.js.
            # office-manager runs office_manager.js, so a probe that only ever
            # looks for agent_manager.js reports a healthy, running component
            # as dead -- permanently, and with no data to correct it, because
            # office-manager's status.json carries no pid. Only consulted once
            # the primary entrypoint is not running, and deliberately still
            # gated on agent_manager.js existing, so agents that never had one
            # (graph-backend) keep being skipped and the denominator is
            # unchanged. ".backup" copies are excluded so a retired script
            # cannot make a stopped agent look alive.
            alternates = [
                os.path.join(agents_dir, name, "bin", n)
                for n in sorted(os.listdir(os.path.join(agents_dir, name, "bin")))
                if n.endswith(".js")
                and n != "agent_manager.js"
                and ".backup" not in n
            ]
            if any(_alive(a) or _alive_case_insensitive(a) for a in alternates):
                alive += 1
            else:
                dead.append(name)
    if total == 0:
        checks.append(_check("agents", False, "no agent managers found", checked=False))
    else:
        # One dead agent degrades the system; it does not make it unhealthy.
        checks.append(_check(
            "agents", alive > 0,
            "%d/%d agent manager(s) alive%s" % (
                alive, total,
                "" if not dead else "; not running: " + ", ".join(dead[:8]),
            ),
            level="fail" if alive == 0 else "warn",
        ))

    # --- feed daemon alive ---
    feed = _alive("continuous_feed_daemon")
    checks.append(_check(
        "feed", bool(feed),
        "running (pid %s)" % feed.split("\n")[0] if feed else "not running",
        level="warn",
    ))

    # --- floor health, if the module exists ---
    fh = os.path.join(hive, "lib", "floor_health.py")
    if os.path.exists(fh):
        try:
            out = subprocess.run(
                [sys.executable, fh, "--json"], capture_output=True, text=True, timeout=20
            )
            result = json.loads(out.stdout)
            floors = result.get("floors", [])
            bad = [f for f in floors if f.get("state") in ("FAILED", "STOPPED")]
            counts = {}
            for f in floors:
                counts[f.get("state")] = counts.get(f.get("state"), 0) + 1
            checks.append(_check(
                "floors", not bad,
                ", ".join("%s=%d" % (k, v) for k, v in sorted(counts.items())),
                level="warn",
            ))
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            checks.append(_check("floors", False, "probe failed: %s" % exc, checked=False))
    else:
        unverified.append("floors")

    failing = [c for c in checks if not c["ok"] and c["level"] == "fail"]
    warning = [c for c in checks if not c["ok"] and c["level"] == "warn"]

    return {
        "ok": not failing,
        "checked_at": int(time.time() * 1000),
        "hive": hive,
        "checks": checks,
        "failing": [c["check"] for c in failing],
        "warnings": [c["check"] for c in warning],
        "not_verified": unverified,
    }


if __name__ == "__main__":
    print(json.dumps(probe(), indent=2))
