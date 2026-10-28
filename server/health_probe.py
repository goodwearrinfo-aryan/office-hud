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
import re
import subprocess
import sys
import time

HIVE = os.environ.get("OPENALICE_HIVE") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", ".."
)


def _hive_dir():
    return os.path.abspath(HIVE)


def _check(name, ok, detail, level="fail", checked=True, extra=None):
    """Build one check record.

    `level` is the severity the check carries *right now*, not the severity it
    would carry if it were failing.

    A passing check may carry "warn": degraded is not the same as broken, and
    the agents check needs to say "16 of 62 managers alive" without that
    reading as either healthy or a hard failure. Forcing level to "ok" on every
    pass made the caller's `warn` unreachable -- the agents check asked for
    warn and got ok, which is how a fleet running a quarter of its agents
    reported `level: ok` with `ok: true`.

    A passing check may never carry "fail", and a failing check may never carry
    "ok". Both combinations tell a consumer reading one field something the
    other field contradicts -- that is what this substitution exists to
    prevent, so it guards both directions rather than only the one that was
    observed.

    Both aggregate lists below treat these as: "fail" means unhealthy, "warn"
    means worth looking at but not yet unhealthy. So a warning never flips the
    top-level ok, it just stops being invisible.
    """
    if ok and level == "fail":
        level = "ok"
    elif not ok and level == "ok":
        level = "fail"
    return {
        "check": name,
        "ok": bool(ok),
        "level": level,
        "detail": detail,
        "verified": checked,
        # Structured counts for consumers that must not parse `detail`.
        # `detail` is prose written for a human reading a fleet-health line, and
        # a metrics exporter scraping "42/42 agent(s) alive" out of it breaks the
        # moment the sentence is reworded -- which is exactly the kind of change
        # that looks harmless in review.
        **(extra or {}),
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


_WORKER_LABEL_PREFIX = "com.aryan.opencode-worker-"


def _worker_plist_names():
    """Agent names that have a launchd worker plist on *this* host.

    Empty on any host that is not the deployment host, which is why
    `probe()` treats an empty result as "registration unknown" and keeps the
    old denominator rather than concluding that no agent is expected to run.
    """
    try:
        entries = os.listdir(os.path.expanduser("~/Library/LaunchAgents"))
    except OSError:
        return set()
    suffix = ".plist"
    return {n[len(_WORKER_LABEL_PREFIX):-len(suffix)]
            for n in entries
            if n.startswith(_WORKER_LABEL_PREFIX) and n.endswith(suffix)}


def _alive_worker_launcher(name):
    """An agent alive as `opencode-worker.sh <name>` rather than agent_manager.js.

    The fleet's long-lived agents are launched by the repo launcher, so the
    process command line is

        /bin/zsh /Users/a/bin/opencode-worker.sh pm-data

    and never mentions `hive/agents/<name>/bin/agent_manager.js`. Every liveness
    check here keys on that path, so all of them reported false negatives: on the
    mini, 28 workers were running while the probe counted 10, and god, mainbot,
    pm-attribution, pm-data and pm-ops were named as dead in a fleet-health read
    despite having live pids.

    `name` has already been validated against `_AGENT_NAME`, so it needs no
    regex escaping here. The pattern is anchored at the end of the command line
    so `pm-data` cannot be satisfied by `pm-data-worker`, or by any path that
    merely contains the name.
    """
    return _alive("opencode-worker.sh %s$" % name)


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
    live = []
    dead = []
    scaffolds = []
    # Entries that are not agent directories. Something ran a command with an
    # unexpanded or comma-separated variable and the hive rebuild created real
    # scaffolds named "," and "d", "g", "o" -- each with a full
    # bin/agent_manager.js, so the old existence-only filter counted every one
    # of them as a dead agent. That inflated the denominator and put phantom
    # failures in a fleet-health read. A real agent name is an identifier:
    # letters, digits, dash, underscore, at least two characters.
    _AGENT_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]+$")
    skipped = []
    # Candidates are the union of two sources. Enumerating hive directories
    # alone cannot see a worker that has no scaffold, because admission
    # requires hive/agents/<name>/bin/agent_manager.js to exist. On the mini 28
    # workers are registered as launchd jobs and most have no scaffold, so a
    # hive-only read counted 19 of the 38 running agents and reported
    # "19/19 ok" -- an all-clear that ten of them could die inside without
    # changing the answer. Registration contributes the missing names, with no
    # script to inspect, so only the launcher check applies to them.
    candidates = {}
    if os.path.isdir(agents_dir):
        for name in sorted(os.listdir(agents_dir)):
            mgr = os.path.join(agents_dir, name, "bin", "agent_manager.js")
            if not os.path.exists(mgr):
                continue
            if not _AGENT_NAME.match(name):
                skipped.append(name)
                continue
            candidates[name] = mgr
    registered = _worker_plist_names()
    for name in sorted(registered):
        candidates.setdefault(name, None)

    if candidates:
        for name, mgr in sorted(candidates.items()):
            # pgrep -f is case-SENSITIVE on the pattern while the filesystem
            # here is case-INSENSITIVE, so `agents/f1/...` matches the file
            # but never the running process line `agents/F1/...`. Matching the
            # bare filename would also be ambiguous, so match the agent name
            # case-insensitively by asking pgrep for a pattern built from the
            # real on-disk name and matching on the process command itself.
            #
            # The worker launcher is checked alongside the script because it is
            # how the fleet actually runs most of its agents, and a probe that
            # cannot see the dominant launch mode calls live agents dead.
            if _alive_worker_launcher(name) or (mgr and (
                    _alive(mgr) or _alive_case_insensitive(mgr))):
                live.append(name)
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
            if mgr is None:
                dead.append(name)
                continue
            alternates = [
                os.path.join(agents_dir, name, "bin", n)
                for n in sorted(os.listdir(os.path.join(agents_dir, name, "bin")))
                if n.endswith(".js")
                and n != "agent_manager.js"
                and ".backup" not in n
            ]
            if any(_alive(a) or _alive_case_insensitive(a) for a in alternates):
                live.append(name)
            else:
                dead.append(name)

    # A directory in hive/agents/ is not a promise that the agent should be
    # running. The hive rebuild leaves scaffolds behind for agents that were
    # never registered as launchd jobs, and counting those in the denominator
    # manufactured a permanent warn: on the mini, 8 of the 8 "not running"
    # agents had no plist and were simply never meant to start, while all 28
    # plist-registered agents were up. So an agent is *expected* to run when it
    # is registered as a worker job or when it is already running; anything else
    # is a scaffold, named in the detail but excluded from the ratio.
    #
    # Registration is only known on the deployment host. Where no worker plists
    # exist at all, "expected" is unknowable, so every candidate stays in the
    # denominator -- the previous behaviour -- rather than collapsing to 0/N and
    # reporting a healthy host as having nothing to run.
    if registered:
        unstarted = set(dead) - registered
        dead = [n for n in dead if n in registered]
        scaffolds.extend(n for n in sorted(unstarted))

    total = len(live) + len(dead)
    alive = len(live)
    if total == 0:
        checks.append(_check("agents", False, "no agent managers found", checked=False))
    else:
        # One dead agent degrades the system; it does not make it unhealthy.
        # But "degraded" has to survive into the payload, which is the whole
        # reason _check no longer overwrites a caller's warn.
        detail = "%d/%d agent(s) alive%s%s%s" % (
            alive, total,
            "" if not dead else "; not running: " + ", ".join(dead[:8]),
            "" if not scaffolds else
            "; never registered (scaffold): " + ", ".join(scaffolds[:8]),
            "" if not skipped else
            "; ignored non-agent entries: " + ", ".join(repr(s) for s in skipped[:8]),
        )
        checks.append(_check(
            "agents", alive > 0, detail,
            # Severity has to track the state, not just ok/fail. Every manager
            # alive is "ok"; some alive and some dead is "warn"; none alive is
            # "fail". Passing warn unconditionally would report a healthy fleet
            # as degraded, which is the same class of lie as the one this
            # replaces -- just pointing the other way.
            level="fail" if alive == 0 else ("warn" if dead else "ok"),
            # Counts rather than prose, so a metrics exporter never has to
            # scrape the ratio out of the sentence above.
            extra={
                "alive": alive,
                "total": total,
                "dead": list(dead),
                "scaffolds": list(scaffolds),
                "skipped_entries": list(skipped),
            },
        ))

    # --- feed daemon alive ---
    feed = _alive("continuous_feed_daemon")
    checks.append(_check(
        "feed", bool(feed),
        "running (pid %s)" % feed.split("\n")[0] if feed else "not running",
        # Severity tracks state. A running feed is "ok"; a dead one is a
        # degradation worth surfacing rather than a total failure. Passing
        # "warn" unconditionally would report a healthy feed as degraded.
        level="ok" if feed else "warn",
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
                # All floors healthy is "ok"; any in a bad state is "warn".
                level="warn" if bad else "ok",
            ))
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            checks.append(_check("floors", False, "probe failed: %s" % exc, checked=False))
    else:
        unverified.append("floors")

    # "fail" drives the top-level ok; "warn" is surfaced but never fatal, so
    # it is collected regardless of ok -- a check that passes while degraded
    # is exactly the case that used to disappear here.
    failing = [c for c in checks if c["level"] == "fail" and not c["ok"]]
    warning = [c for c in checks if c["level"] == "warn"]

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
