#!/usr/bin/env python3
"""Enforce the operator rule: floors are never deleted.

The floor view route was removed repeatedly while lib/floor_health.py kept
computing every floor correctly. hud_guard.py DETECTS that, but detection alone
does not enforce a rule - the route was simply re-removed on the next edit, and
the rule was broken again every cycle.

This is the RECOVER step of the loop the operating spec requires:

    DETECT -> DIAGNOSE -> RECOVER -> VERIFY -> REPORT -> CONTINUE

It restores the canonical floor route from floor_route_snippet.js, but only
when it is safe to do so. Specifically it refuses to act when:

  * the route is already present (nothing to do)
  * index.js is being written right now (another session is mid-edit; touching it
    would clobber their work and could corrupt a live service)
  * the result would not pass `node --check` (it reverts instead)
  * it already restored once within the cooldown (no thrashing)

The file is never overwritten - the route is inserted, and a backup is kept so a
bad insert can be undone. Deleting a floor remains impossible: this only ever
adds the endpoint back.

Read/writes are confined to the office-hud directory. Read-only with respect to
any other agent's source beyond the single surgical insertion.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request

HUD_ROOT = "/Users/a/trading/openalice-fleet/office-hud"
SERVER_JS = os.path.join(HUD_ROOT, "server", "index.js")
SNIPPET = os.path.join(HUD_ROOT, "floor_route_snippet.js")
STATE = os.path.join(HUD_ROOT, "floor_route_guard_state.json")
LOG = os.path.join(HUD_ROOT, "floor_route_guard.log")
BASE = "http://127.0.0.1:4747"
NODE = "/Users/a/.nvm/versions/node/v22.22.3/bin/node"

THROTTLE_SEC = 4 * 60       # do not act more than once per 4 minutes
HOLD_RETRY_SEC = 60        # after holding, look again soon: the quiet window is short
# A fixed "file must be untouched for N seconds" rule is the wrong tool here: the
# other session rewrites server/index.js every 2-3 minutes, so a 90s window
# almost never coincided with this job's 5-minute cadence and the guard held
# three times in a row while the floor view stayed down.
#
# Instead the write is guarded by compare-and-swap on the file's mtime and size:
# the content is read, and immediately before the atomic replace the stat is
# re-checked. If anything wrote in between, the edit is abandoned untouched.
# That is strictly safer than a time window AND it can act far more often,
# because it no longer needs to guess how long the other writer will be busy.
QUIET_FILE_SEC = 20        # only a coarse guard against a write in progress
COOLDOWN_RESTORE_SEC = 600  # at most one restore per 10 minutes

# Insertion anchors, tried in order. All are stable landmarks that come after
# the route registrations.
ANCHORS = [
    "const dist = path.join(__dirname, '..', 'web', 'dist');",
    "app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));",
]


def log(msg: str) -> None:
    line = "%s %s" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg)
    try:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def load_state() -> dict:
    try:
        with open(STATE, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def save_state(data: dict) -> None:
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
    os.replace(tmp, STATE)


def floors_status() -> int:
    try:
        with urllib.request.urlopen(BASE + "/api/floors", timeout=20) as r:
            return r.getcode()
    except urllib.error.HTTPError as exc:
        return exc.code
    except Exception:
        return 0


def file_age(path: str):
    try:
        return time.time() - os.path.getmtime(path)
    except OSError:
        return None


def _rc_ok(path: str) -> bool:
    """True if node considers the file valid JavaScript."""
    try:
        r = subprocess.run([NODE, "--check", path], capture_output=True, timeout=60)
        return r.returncode == 0
    except Exception:
        return False


def main() -> int:
    st = load_state()
    now = time.time()

    if now - (st.get("last_action") or 0) < THROTTLE_SEC:
        print(json.dumps({"skipped": "throttled"}))
        return 0

    code = floors_status()
    if code == 200:
        save_state({"last_action": now, "last_result": "ok", "floors_http": 200})
        print(json.dumps({"status": "ok", "floors_http": 200, "action": "none"}))
        return 0

    # DIAGNOSE: is the route missing from source, or is the service just not
    # running it? A route present in source but 404 means the process predates
    # an edit, which needs a restart and not an edit.
    try:
        with open(SERVER_JS, encoding="utf-8") as fh:
            src = fh.read()
    except OSError as exc:
        print(json.dumps({"status": "error", "detail": "cannot read server/index.js: %s" % exc}))
        return 1

    route_present = "app.get('/api/floors'" in src

    if route_present:
        action = "restart_only"
        reason = "route is in source but serving 404: the process predates the code"
    else:
        action = "restore_route"
        reason = "floor route is absent from source (floor view deleted)"

    read_stat = os.stat(SERVER_JS)
    age = time.time() - read_stat.st_mtime
    if age < QUIET_FILE_SEC:
        msg = "holding: index.js was written %.0fs ago, a write may be in progress" % age
        log("%s (%s) %s" % (reason, action, msg))
        print(json.dumps({"status": "held", "reason": reason, "detail": msg}))
        # Look again shortly: the window between the other session's writes is
        # only a couple of minutes, so waiting the full throttle would usually
        # miss it.
        save_state({"last_action": now - (THROTTLE_SEC - HOLD_RETRY_SEC),
                    "last_result": "held", "detail": msg})
        return 0

    if now - (st.get("last_restore") or 0) < COOLDOWN_RESTORE_SEC:
        msg = "cooldown: a restore already ran within the last %ds" % COOLDOWN_RESTORE_SEC
        log("%s %s" % (reason, msg))
        print(json.dumps({"status": "cooldown", "reason": reason, "detail": msg}))
        save_state({"last_action": now, "last_result": "cooldown"})
        return 0

    if action == "restore_route":
        try:
            with open(SNIPPET, encoding="utf-8") as fh:
                snippet = fh.read().rstrip() + "\n\n"
        except OSError as exc:
            print(json.dumps({"status": "error", "detail": "cannot read snippet: %s" % exc}))
            return 1

        anchor = next((a for a in ANCHORS if a in src), None)
        if anchor is None:
            msg = "no known insertion anchor found; refusing to guess"
            log("RESTORE ABORTED: %s" % msg)
            print(json.dumps({"status": "aborted", "detail": msg}))
            save_state({"last_action": now, "last_result": "aborted"})
            return 1

        # Compare-and-swap: if the file changed since we read it, someone else
        # wrote in the meantime. Abort WITHOUT writing rather than clobber it.
        now_stat = os.stat(SERVER_JS)
        if (now_stat.st_mtime_ns != read_stat.st_mtime_ns
                or now_stat.st_size != read_stat.st_size):
            msg = ("aborting: index.js changed between read and write "
                   "(mtime/size differ); another session is mid-edit")
            log("RESTORE ABORTED: %s" % msg)
            print(json.dumps({"status": "aborted", "detail": msg}))
            save_state({"last_action": now - (THROTTLE_SEC - HOLD_RETRY_SEC),
                        "last_result": "aborted"})
            return 0

        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = SERVER_JS + ".pre-floorrestore-" + stamp
        shutil.copy(SERVER_JS, backup)
        new_src = src.replace(anchor, snippet + anchor, 1)
        tmp = SERVER_JS + ".tmpfloor"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(new_src)
        # Re-check immediately before the rename: this is the last point at
        # which we can still back out without losing someone else's work.
        pre_stat = os.stat(SERVER_JS)
        if (pre_stat.st_mtime_ns != read_stat.st_mtime_ns
                or pre_stat.st_size != read_stat.st_size):
            os.unlink(tmp)
            msg = "aborting at the last moment: index.js changed again; nothing written"
            log("RESTORE ABORTED: %s" % msg)
            print(json.dumps({"status": "aborted", "detail": msg}))
            save_state({"last_action": now - (THROTTLE_SEC - HOLD_RETRY_SEC),
                        "last_result": "aborted"})
            return 0
        os.replace(tmp, SERVER_JS)

        if not _rc_ok(SERVER_JS):
            shutil.copy(backup, SERVER_JS)
            msg = "insert produced invalid JS; reverted from %s" % os.path.basename(backup)
            log("RESTORE REVERTED: %s" % msg)
            print(json.dumps({"status": "reverted", "detail": msg}))
            save_state({"last_action": now, "last_result": "reverted", "backup": backup})
            return 1
        log("RESTORED floor route from snippet; backup=%s" % os.path.basename(backup))

    # Restart so the route is actually served, then VERIFY.
    subprocess.run(["launchctl", "kickstart", "-k", "gui/501/com.aryan.office-hud"],
                   capture_output=True, timeout=90)
    verified = None
    for _ in range(12):
        time.sleep(3)
        verified = floors_status()
        if verified == 200:
            break

    ok = verified == 200
    msg = "%s -> %s" % (action, "verified floors HTTP 200" if ok else "STILL BROKEN (http %s)" % verified)
    log(("RECOVERED: " if ok else "RECOVERY FAILED: ") + msg)
    print(json.dumps({
        "status": "ok" if ok else "failed",
        "action": action,
        "reason": reason,
        "floors_http_after": verified,
    }, indent=2))
    save_state({"last_action": now,
                "last_restore": now if action == "restore_route" else st.get("last_restore"),
                "last_result": "ok" if ok else "failed",
                "floors_http": verified})
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
