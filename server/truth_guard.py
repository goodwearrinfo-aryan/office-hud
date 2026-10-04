#!/usr/bin/env python3
"""Guard against silent reversion of the truthful HUD endpoints.

Why this exists
---------------
`/api/health` shipped a literal `ok: true` -- it reported success
unconditionally, even with the hive missing or every agent dead. That was
fixed by computing it from server/health_probe.py.

That fix was then silently reverted. Twice. A concurrent process rewrote
office-hud/server/index.js wholesale (backups named index.js.presecurity-*,
index.js.prex-*) and each rewrite dropped the wiring. The hardcoded
`ok: true` came back, and nothing failed. The regression was invisible.

The same risk applies to /api/floors, whose producer module
(server/floor_health.js) is durable but whose two-line route is not.

What this does
--------------
Checks the live server and fails when:
  * /api/health reports ok without any supporting check evidence
  * /api/health is unreachable
  * /api/floors is missing, or reports a floor as healthy while its own
    payload says not_verified

This is a guard, not a status page. It is meant to run in the repo's test
suite and in the HUD guard loop so a revert fails loudly instead of
quietly restoring a lie.
"""

import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("HUD_BASE", "http://127.0.0.1:4747")
TIMEOUT = float(os.environ.get("HUD_TIMEOUT", "40"))


def fetch(path):
    url = BASE.rstrip("/") + path
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as resp:
            body = resp.read().decode("utf-8", "replace")
            return resp.status, json.loads(body)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"raw": raw[:200]}
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return None, {"error": str(exc)}


def check_health():
    status, body = fetch("/api/health")
    if status is None:
        return False, "unreachable: %s" % body.get("error")
    if status != 200:
        return False, "HTTP %s" % status

    # The regression signature: ok present, but no evidence behind it.
    if "checks" not in body:
        return False, (
            "ok=%r reported with no supporting checks -- this is the "
            "hardcoded-ok regression" % body.get("ok")
        )
    if body.get("ok") is True:
        failing = [c for c in body.get("checks", []) if not c.get("ok")]
        blocking = [c for c in failing if c.get("level") == "fail"]
        if blocking:
            return False, "ok=true but failing: %s" % [c["check"] for c in blocking]
    return True, "ok=%r with %d check(s)" % (body.get("ok"), len(body.get("checks", [])))


def check_floors():
    status, body = fetch("/api/floors")
    if status is None:
        return False, "unreachable: %s" % body.get("error")
    if status != 200:
        return False, "HTTP %s" % status
    if "floors" not in body:
        return False, "no floors key -- route reverted or unwired"
    floors = body.get("floors") or []
    if not floors:
        return False, "empty floor list"
    if body.get("not_verified") and body.get("source") in ("unavailable", "error"):
        # Degradation is legitimate, but it must be labelled, and the states
        # must not claim health.
        bad = [f for f in floors if f.get("state") not in ("UNKNOWN", None)]
        if bad:
            return False, "not_verified but %d floor(s) claim a real state" % len(bad)
        return True, "probe unavailable, all floors correctly UNKNOWN"
    return True, "%d floor(s), %s" % (
        len(floors),
        json.dumps(body.get("summary") or {}),
    )


def check_task_truth():
    """Does the task board distinguish evidenced completion from assertion?

    Measured on the live hive: 604 tasks report COMPLETE but only 410 are
    evidenced work -- 93 are verified OFF_TOPIC and 97 are weak. The board
    collapses all of them into a "done" column, which is the spec's
    "do not mark work completed from intention alone" violation, and it is
    the single largest overstatement the HUD makes (32%).

    This is reported as a FAILURE, not a warning. The fix is a product
    decision with a requeue/quarantine blast radius and belongs to whoever
    owns the task pipeline; until then the HUD overstates completed work and
    that should stay visible rather than being quietly tolerated.
    """
    status, body = fetch("/api/live/taskBoard")
    if status is None:
        return False, "unreachable: %s" % body.get("error")
    if status != 200:
        return False, "HTTP %s" % status

    counts = body.get("counts") or {}
    done = counts.get("done")
    if done is None:
        return False, "task board has no done column"

    # The board must surface the evidenced/unsupported split rather than a
    # single done number. Absent the split, every completion reads as proof.
    split = body.get("evidenced")
    if split is None:
        return False, (
            "board reports %d done with no evidenced/unsupported split -- "
            "%d completions are unverified" % (done, done)
        )
    if split.get("unsupported_share", 0) > 0:
        return False, (
            "%d of %d completions unsupported (%.1f%%) and the board "
            "collapses them into done" % (
                split.get("unsupported_completions", 0), done,
                100 * split.get("unsupported_share", 0),
            )
        )
    return True, "%d done, all evidenced" % done


def main():
    failures = []
    for name, fn in (
        ("/api/health", check_health),
        ("/api/floors", check_floors),
        ("/api/taskBoard", check_task_truth),
    ):
        try:
            ok, detail = fn()
        except Exception as exc:  # a guard must not crash the suite
            ok, detail = False, "guard error: %s" % exc
        print("  %-14s %-5s %s" % (name, "PASS" if ok else "FAIL", detail))
        if not ok:
            failures.append(name)

    if failures:
        print("\n  REGRESSION: %s reverted or degraded" % ", ".join(failures))
        return 1
    print("\n  All truth guards pass.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
