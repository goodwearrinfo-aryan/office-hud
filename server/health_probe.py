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
  hive              - HIVE directory exists and is readable
  tasks             - tasks.json parses and is a list/dict
  local_agents      - how many LOCAL agent managers are alive on this host
  remote_fleet      - remote fleet health via terminals.json evidence
  feed              - the task feed daemon is alive
  floors            - evidence-based floor states, when floor_health.py exists

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

HIVE = os.environ.get("OPENALICE_HIVE") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", ".."
)

# Staleness threshold matches SESSION_STALE_MS in server/index.js (5 minutes)
REMOTE_STALE_SEC = 300


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


def _check_remote_fleet(hive):
    """Check remote fleet health via terminals.json evidence.

    The Mac Mini publishes its terminal/agent state to hive/remote/Mac/terminals.json
    via the push-terminals-to-laptop.sh script. We use this as trusted cross-host
    evidence rather than attempting local process discovery on a remote machine.
    """
    remote_dir = os.path.join(hive, "remote")
    if not os.path.isdir(remote_dir):
        return _check("remote_fleet", False, "no remote hosts directory", level="warn", checked=False)

    hosts = []
    try:
        entries = os.listdir(remote_dir)
    except OSError:
        return _check("remote_fleet", False, "cannot read remote hosts directory", level="warn", checked=False)

    total_remote_managers = 0
    fresh_remote_managers = 0
    stale_hosts = []
    unreachable_hosts = []
    now = time.time()

    for entry in entries:
        if entry.startswith("."):
            continue
        host_dir = os.path.join(remote_dir, entry)
        if not os.path.isdir(host_dir):
            continue

        terminals_file = os.path.join(host_dir, "terminals.json")
        if not os.path.exists(terminals_file):
            unreachable_hosts.append(entry)
            continue

        try:
            with open(terminals_file, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError) as exc:
            unreachable_hosts.append(f"{entry}: unreadable ({exc})")
            continue

        collected_at = data.get("collected_at")
        agent_sessions = data.get("agent_sessions", [])

        # Check collector freshness
        collector_age = None
        if collected_at:
            try:
                from datetime import datetime, timezone
                collected = datetime.fromisoformat(collected_at.replace("Z", "+00:00"))
                if collected.tzinfo is None:
                    collected = collected.replace(tzinfo=timezone.utc)
                collector_age = (datetime.now(timezone.utc) - collected).total_seconds()
            except ValueError:
                pass

        host_stale = collector_age is None or collector_age > REMOTE_STALE_SEC

        # Count manager agents (F1-F12, PM-*, god, mainbot, mastercoordinator, etc.)
        manager_ids = set()
        for session in agent_sessions:
            agent_id = session.get("agent_id", "")
            if not agent_id:
                continue
            # Count manager-type agents (those with heartbeats)
            last_hb = session.get("last_heartbeat")
            hb_age = None
            if last_hb:
                try:
                    from datetime import datetime, timezone
                    hb_time = datetime.fromisoformat(last_hb.replace("Z", "+00:00"))
                    if hb_time.tzinfo is None:
                        hb_time = hb_time.replace(tzinfo=timezone.utc)
                    hb_age = (datetime.now(timezone.utc) - hb_time).total_seconds()
                except ValueError:
                    pass

            total_remote_managers += 1
            if hb_age is not None and hb_age <= REMOTE_STALE_SEC:
                fresh_remote_managers += 1

        host_name = data.get("host", entry)
        hosts.append({
            "host": host_name,
            "collector_age_sec": collector_age,
            "stale": host_stale,
            "agent_count": len(agent_sessions),
        })

        if host_stale:
            stale_hosts.append(f"{host_name} (collector age: {collector_age:.0f}s)" if collector_age else f"{host_name} (no collector timestamp)")
        else:
            fresh_remote_managers = max(fresh_remote_managers, len(agent_sessions))

    if not hosts:
        return _check("remote_fleet", False, "no remote hosts found", level="warn", checked=False)

    # Determine overall remote fleet health
    all_stale = all(h["stale"] for h in hosts)
    any_fresh = any(not h["stale"] for h in hosts)

    if all_stale:
        detail = "all remote hosts stale: " + ", ".join(stale_hosts)
        level = "fail"
        ok = False
    elif unreachable_hosts:
        detail = f"{len(hosts)} host(s) fresh, {len(unreachable_hosts)} unreachable: {', '.join(unreachable_hosts[:3])}"
        level = "warn"
        ok = True
    else:
        host_details = ", ".join(f"{h['host']}={h['agent_count']} agents" for h in hosts)
        detail = f"{len(hosts)} remote host(s) fresh ({host_details})"
        level = "warn" if fresh_remote_managers < total_remote_managers else "warn"  # warn because not all managers have fresh heartbeats
        ok = True

    return _check("remote_fleet", ok, detail, level=level, checked=True)


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

    # --- local agent managers alive (on THIS host) ---
    agents_dir = os.path.join(hive, "agents")
    total = alive = 0
    dead = []
    if os.path.isdir(agents_dir):
        for name in sorted(os.listdir(agents_dir)):
            mgr = os.path.join(agents_dir, name, "bin", "agent_manager.js")
            if not os.path.exists(mgr):
                continue
            total += 1
            if _alive(mgr) or _alive_case_insensitive(mgr):
                alive += 1
                continue
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
        checks.append(_check("local_agents", True, "no local agent managers (expected on HUD host)", level="warn", checked=True))
    else:
        checks.append(_check(
            "local_agents", alive > 0,
            "%d/%d local agent manager(s) alive%s" % (
                alive, total,
                "" if not dead else "; not running: " + ", ".join(dead[:8]),
            ),
            level="fail" if alive == 0 else "warn",
        ))

    # --- remote fleet health (Mac Mini etc.) ---
    remote_check = _check_remote_fleet(hive)
    checks.append(remote_check)

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
            floors = json.loads(out.stdout)
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
