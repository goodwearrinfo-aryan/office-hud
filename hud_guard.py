#!/usr/bin/env python3
"""Guard the office-hud against silently losing truthfulness.

Why this shape: office-hud/server/index.js is being edited by more than one
process on this machine. Two verified changes were reverted by a concurrent
writer within minutes, and nothing noticed - the page still rendered and every
endpoint still answered 200 while the fields were simply gone.

So this asserts OUTCOMES, not implementation. An earlier version of this guard
checked for specific function names; that version was wrong, because a different
session is legitimately building the same capabilities under different names.
A guard that hardcodes one author's internals goes red the moment anyone
improves on it, and a permanently-red guard is worse than none.

What is asserted is the brief's actual invariants:

  * the service answers
  * every view the brief requires is reachable
  * agents expose a real process id
  * staleness is observable, not assumed
  * all twelve floors are reported, and each floor states a manager liveness
    fact rather than being called healthy on the strength of existing

Shape tolerance is real, not aspirational. The previous version claimed it
"deliberately does not assert any particular field name, so it survives
refactors" and then hardcoded three of them; the refactor it was supposed to
survive renamed the field, and the guard spent a day reporting a false
regression against a healthy system. Liveness is now matched by evidence TYPE
-- a boolean liveness field, a non-empty state string, or integer state
counters -- so a rename cannot silently pass and a rename cannot silently fail
either.

Read-only. Non-zero exit on failure so launchd records it.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

# Dynamic path resolution - supports both launchd env vars and direct execution
_hud_root = os.environ.get("OFFICE_HUD_ROOT")
if _hud_root:
    HUD_ROOT = _hud_root
else:
    # hud_guard.py lives in <repo>/office-hud/, so go up one level to get the office-hud dir
    HUD_ROOT = os.path.dirname(os.path.abspath(__file__))

BASE = "http://127.0.0.1:4747"
STATE = os.path.join(HUD_ROOT, "hud_guard_state.json")
BASELINE = os.path.join(HUD_ROOT, "hud_guard_baseline.json")
LOG = os.path.join(HUD_ROOT, "hud_guard.log")
# Operator rule: floors are permanent, growth is additive only.
# Monotonic record of every floor id ever observed; union-only, never pruned,
# so a floor deletion stays detectable rather than looking like a smaller list.
FLOOR_LEDGER = os.path.join(HUD_ROOT, "floor_ledger.json")
# The hive is the runtime data root; identity.md lives under it.
_hive = os.environ.get("OPENALICE_HIVE") or os.environ.get("OFFICE_HUD_HIVE")
if _hive:
    HIVE = _hive
else:
    HIVE = os.path.join(os.path.dirname(HUD_ROOT), "hive")

THROTTLE_SEC = 9 * 60

REQUIRED_VIEWS = [
    ("/api/agents", "agent view"),
    # Floors live inside /api/summary. /api/floors appears in no commit in this
    # repo's history and never answered; asserting it made the guard exit 1
    # every 10 minutes against a system that was working. The floor invariant
    # itself is not weakened -- it moved to the floor check, which reads the
    # real source.
    ("/api/summary", "summary + floor hierarchy"),
    ("/api/terminals", "terminal / opencode view"),
    ("/api/tasks", "task view"),
    ("/api/events", "event stream"),
    ("/api/projects", "project view"),
    ("/api/health", "health"),
]

# Words that would mean a view is asserting health without evidence. The brief
# forbids turning "no error detected" into "healthy".
UNEVIDENCED_HEALTH = {"healthy", "ok", "fine", "good", "up"}

# Evidence, not names. A floor qualifies if it carries ANY of: a boolean
# liveness fact, a non-empty state string, or integer state counters. The real
# payload uses leadIsLive plus running/working/idle/stale/failed/offline; a
# previous payload used manager_alive. Both are recognised because both are real
# evidence, not because either name is special.
LIVENESS_BOOL_FIELDS = ("leadIsLive", "manager_alive", "managerAlive", "alive")
LIVENESS_STATE_FIELDS = ("runtimeState", "state")
COUNTER_FIELDS = ("running", "working", "idle", "stale", "failed", "offline")


def floor_liveness_evidence(f: Dict[str, Any]) -> List[str]:
    """Names of the real liveness facts in `f`, empty list if it has none."""
    ev: List[str] = []
    if not isinstance(f, dict):
        return ev
    for k in LIVENESS_BOOL_FIELDS:
        if isinstance(f.get(k), bool):
            ev.append(k)
    for k in LIVENESS_STATE_FIELDS:
        v = f.get(k)
        if isinstance(v, str) and v.strip():
            ev.append(k)
    if any(isinstance(f.get(k), int) and not isinstance(f.get(k), bool)
           for k in COUNTER_FIELDS):
        ev.append("state counters")
    return ev


WORKING_STATES = {"working", "busy"}

# Signals that an agent is doing something, in descending order of directness.
# A heartbeat is deliberately NOT sufficient on its own: the brief says a
# heartbeat is not proof of work.
def agent_work_evidence(a: Dict[str, Any]) -> List[str]:
    ev_in = a.get("evidence") if isinstance(a.get("evidence"), dict) else {}
    ev: List[str] = []
    if ev_in.get("hasTask") or a.get("currentTaskId"):
        ev.append("has task")
    if a.get("currentTaskTitle") or a.get("currentTask"):
        ev.append("task title")
    if a.get("lastTool"):
        ev.append("last tool")
    last = a.get("lastActiveSecAgo")
    if isinstance(last, (int, float)) and last < 300:
        ev.append("active <300s")
    return ev


# Signals that an agent is up at all. Wider than work evidence on purpose: an
# idle agent can be perfectly healthy, and healthy is not a claim of activity.
def agent_up_evidence(a: Dict[str, Any]) -> List[str]:
    ev_in = a.get("evidence") if isinstance(a.get("evidence"), dict) else {}
    ev: List[str] = []
    if ev_in.get("sessionFresh") is True:
        ev.append("fresh session")
    if ev_in.get("hasSession") is True and ev_in.get("sessionFresh") is True:
        ev.append("session+sessionFresh")
    hb = ev_in.get("heartbeatAgeSec")
    if isinstance(hb, (int, float)) and hb < 300:
        ev.append("heartbeat <300s")
    if ev_in.get("hasTask") or a.get("currentTaskId"):
        ev.append("has task")
    # A recorded processId is deliberately NOT counted. It is a claim that a
    # process exists, not a measurement that it does, and this guard already
    # reports the hardcoded processVerified=false as a defect for exactly that
    # reason. Accepting the bare id here would make the file contradict itself:
    # invariant 8 says a recorded PID proves nothing, and this helper would be
    # treating the same recorded PID as evidence of being up.
    return ev


def scan_unbacked_state_claims():
    """Agents whose reported state is not backed by any corroborating fact.

    Returns (unbacked_working, unbacked_healthy, checked).
    """
    working_bad: List[str] = []
    healthy_bad: List[str] = []
    checked = 0
    try:
        with urllib.request.urlopen(BASE + "/api/agents", timeout=20) as resp:
            body = json.loads(resp.read().decode("utf-8", "replace"))
    except Exception:
        return working_bad, healthy_bad, checked
    agents = body.get("agents", body) if isinstance(body, dict) else body
    if not isinstance(agents, list):
        return working_bad, healthy_bad, checked
    for a in agents:
        if not isinstance(a, dict):
            continue
        status = str(a.get("status") or a.get("state") or "").strip().lower()
        if status not in WORKING_STATES and status not in UNEVIDENCED_HEALTH:
            continue
        checked += 1
        name = str(a.get("id") or a.get("name") or "?")
        if status in WORKING_STATES and not agent_work_evidence(a):
            working_bad.append("%s(status=%s)" % (name, status))
        elif status in UNEVIDENCED_HEALTH and not agent_up_evidence(a):
            healthy_bad.append("%s(status=%s)" % (name, status))
    return working_bad, healthy_bad, checked


def floor_health_claim(f: Dict[str, Any]) -> Optional[str]:
    """A bare health word with nothing behind it, as 'health=healthy'."""
    if not isinstance(f, dict):
        return None
    for k in ("health", "state"):
        v = f.get(k)
        if isinstance(v, str) and v.strip().lower() in UNEVIDENCED_HEALTH:
            return "%s=%s" % (k, v.strip())
    return None

# Routes whose payloads are scanned for credentials. /api/tasks is the one that
# carries arbitrary human text (task descriptions, diffs, output) and is by far
# the most likely place for a pasted key to end up.
SECRET_SCAN_ROUTES = ["/api/agents", "/api/tasks", "/api/events", "/api/terminals", "/api/sessions"]

SECRET_PATTERNS = [
    ("anthropic", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}")),
    ("openai", re.compile(r"\bsk-(?!ant-)[A-Za-z0-9]{32,}")),
    ("google", re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}")),
    ("aws", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("privatekey", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("slack", re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{20,}")),
    ("github", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}")),
]

# Published example values, and obvious placeholders. These are not leaks and
# flagging them is how a scanner becomes noise. `abcd1234efgh` is the repeating
# block pattern used by the standard secret-regex doc tables (ghp_abcd1234efgh...):
# sequential letter+4-digit blocks are a textbook placeholder, never a live token.
SECRET_ALLOWLIST = re.compile(
    r"EXAMPLE|X{6,}|abcdef|abcd1234efgh|1234567890|placeholder|YOUR_|REDACTED|\.\.\.",
    re.IGNORECASE,
)


def scan_floor_rows():
    """Separate "no usable state" from "not a floor at all".

    Returns (nulls, nonfloors, source). A row with a null state is unevidenced;
    a row whose id is not a floor id is not a floor regardless of state. These
    are different faults and are reported separately.
    """
    for path in ("/api/summary", "/api/floors"):
        code, body = fetch(path)
        if code != 200 or not isinstance(body, dict):
            continue
        rows = body.get("floors")
        if not isinstance(rows, list) or not rows:
            continue
        nulls, nonfloors = [], []
        for r in rows:
            if not isinstance(r, dict):
                continue
            label = str(r.get("floor") or r.get("id") or "?")
            state = r.get("state")
            alive = r.get("manager_alive", r.get("runtimeState", "__absent__"))
            if not state or alive is None:
                nulls.append(label)
            if not _FLOOR_ID_RE.match(label.lower()):
                nonfloors.append(label)
        return nulls, nonfloors, path
    return [], [], "no floor payload"


def scan_for_secrets():
    """Return (leaks, routes_scanned). High confidence patterns only."""
    leaks = []
    scanned = 0
    for route in SECRET_SCAN_ROUTES:
        try:
            with urllib.request.urlopen(BASE + route, timeout=20) as resp:
                raw = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError:
            continue
        except Exception:
            continue
        scanned += 1
        for name, pat in SECRET_PATTERNS:
            for m in pat.finditer(raw):
                val = m.group(0)
                if SECRET_ALLOWLIST.search(val):
                    continue
                leaks.append((name + "@" + route, val))
    return leaks, scanned



def log(msg: str) -> None:
    try:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write("%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg))
    except OSError:
        pass


def load(path: str) -> Dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def save(path: str, data: Dict[str, Any]) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
    os.replace(tmp, path)


def fetch(path: str, timeout: int = 8) -> Tuple[int, Any]:
    """Return (status, parsed_json_or_None).

    The body is parsed best-effort. Some routes legitimately return HTML (the
    SPA shell at "/"), and an earlier version of this guard raised inside
    json.loads, swallowed it, and reported a healthy page as http 0. Reachable
    but non-JSON must never read as unreachable.
    """
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as resp:
            code = resp.getcode()
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except Exception:
        return 0, None
    try:
        return code, json.loads(raw)
    except Exception:
        return code, None


def classify_verification(withheld, checked, claimed_true, unassessable):
    """Turn the four scanner values into one verdict. Pure: no I/O.

    Returns (status, message) where status is "ok" or "degraded".

    The only branch allowed to return "ok" is the last one, where every
    inspectable agent positively asserts processVerified. Everything else is
    reported, including the "nothing was inspectable" case, because a guard that
    cannot see must say NOT VERIFIED rather than pass.
    """
    if checked == 0:
        return "degraded", (
            "NOT VERIFIED: 0 agents were inspectable for process verification, so "
            "no conclusion is possible. The /api/agents evidence shape likely "
            "changed. This is not a pass.")
    if withheld:
        names = ", ".join(name for name, _pid in withheld[:3])
        return "degraded", (
            "%d agent(s) claim processVerified=false while their PID is alive "
            "(e.g. %s); liveness evidence is available and withheld"
            % (len(withheld), names))
    if unassessable:
        return "degraded", (
            "NOT VERIFIED: %d of %d inspected agent(s) make no boolean "
            "processVerified claim (e.g. %s). An agent that asserts nothing is "
            "not a verified agent."
            % (len(unassessable), checked, ", ".join(unassessable[:5])))
    return "ok", ("process verification truthful (%d/%d agents assert verified)"
                  % (claimed_true, checked))


def scan_withheld_verification():
    """Agents claiming they are unverified while their PID is actually alive.

    Returns (withheld, checked, claimed_true, unassessable).

    withheld      [(agent_id, pid)] claiming unverified while the PID is alive.
    checked       agents whose evidence object and processId were inspectable.
    claimed_true  agents that actually assert processVerified is true.
    unassessable  [agent_id] inspected but carrying no boolean claim at all.

    The last two are the whole point. "Inspected and found no lie" is not
    "verified": an agent whose payload omits processVerified has made no claim,
    and the brief requires that to be reported as NOT VERIFIED rather than
    folded into a pass. Collapsing these two states is what let the guard report
    status=ok while all 58 agents carried the hardcoded false.
    """
    withheld = []
    unassessable = []
    claimed_true = 0
    checked = 0
    try:
        with urllib.request.urlopen(BASE + "/api/agents", timeout=20) as resp:
            body = json.loads(resp.read().decode("utf-8", "replace"))
    except Exception:
        return withheld, checked, claimed_true, unassessable
    agents = body.get("agents", body) if isinstance(body, dict) else body
    if not isinstance(agents, list):
        return withheld, checked, claimed_true, unassessable
    for a in agents:
        if not isinstance(a, dict):
            continue
        ev = a.get("evidence")
        pid = a.get("processId")
        if not isinstance(ev, dict) or not pid:
            continue
        checked += 1
        claim = ev.get("processVerified")
        if claim is False and pid_alive(pid):
            withheld.append((str(a.get("id")), pid))
        elif claim is True:
            claimed_true += 1
        else:
            # No boolean claim: absent, null, or something else entirely. The
            # agent makes no verification statement, so its liveness is
            # unverified. That is a reportable state, not a silent pass.
            unassessable.append(str(a.get("id") or a.get("name") or "?"))
    return withheld, checked, claimed_true, unassessable


def pid_alive(pid):
    try:
        n = int(pid)
        if n <= 0:
            return False
        os.kill(n, 0)
        return True
    except (ValueError, TypeError):
        return False
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by someone else
    except OSError:
        return False


def check() -> Tuple[List[Dict[str, str]], List[Dict[str, str]], List[str]]:
    missing: List[Dict[str, str]] = []
    degradations: List[Dict[str, str]] = []
    ok: List[str] = []

    # 1. The service itself must answer.
    code, _ = fetch("/", timeout=8)
    if code == 200:
        ok.append("GET / 200")
    else:
        missing.append({"check": "service up", "detail": "GET / -> http %s" % code})

    # 2. Every view the brief requires must be reachable.
    for path, label in REQUIRED_VIEWS:
        code, _ = fetch(path)
        if code == 200:
            ok.append("%s %s" % (path, label))
        else:
            missing.append({"check": label, "detail": "%s -> http %s" % (path, code)})

    # 3. Agents must expose a real process id and observable staleness.
    code, body = fetch("/api/agents")
    agents = []
    if code == 200 and isinstance(body, dict):
        agents = body.get("agents", body)
        agents = agents if isinstance(agents, list) else []
    if agents:
        with_pid = sum(1 for a in agents if isinstance(a, dict) and a.get("processId"))
        ok.append("agents=%d with real processId=%d" % (len(agents), with_pid))
        if with_pid == 0:
            missing.append({
                "check": "agent process evidence",
                "detail": "no agent exposes a processId; process liveness is unproven",
            })
        # Staleness must be observable somewhere on the agent record, otherwise
        # a stale roster silently presents as a live one.
        staleness_keys = {"rosterStale", "rosterAgeSeconds", "rosterObservedAt", "runtimeState", "heartbeatAgeSec"}
        sample = next((a for a in agents if isinstance(a, dict)), {})
        if not (staleness_keys & set(sample.keys())):
            missing.append({
                "check": "agent staleness observable",
                "detail": "agent record exposes no staleness/verification field",
            })
        else:
            ok.append("agent staleness fields present")
    elif code == 200:
        missing.append({"check": "agent view", "detail": "returned no agents"})

    # 3b. The roster is a file, and a stale file presents exactly like a live
    # one: no crash, no missing field, just old. Live heartbeats cannot stand in
    # for it. They prove the agents they reach are alive, not that the registry
    # is current -- an agent registered after the last write is invisible, and
    # one removed after it lingers as a ghost. So the roster's own age is
    # required, and a stale one is reported rather than trusted.
    code, body = fetch("/api/summary")
    if code == 200 and isinstance(body, dict):
        # Canonical roster freshness names, per the contract published in
        # 9dcbe55: age_seconds / stale / stale_after_seconds. This check still
        # read rosterAgeSeconds / rosterStale, which that commit retired, so the
        # age always came back None. The effect was twofold and both bad: the
        # guard reported a missing capability that exists, while the real
        # staleness check below it never fired, because an absent key is falsy.
        roster = body.get("fleet") or {}
        age = roster.get("age_seconds")
        if age is None:
            missing.append({
                "check": "roster age observable",
                "detail": "the agent roster publishes no age_seconds, so its "
                          "staleness cannot be verified",
            })
        elif roster.get("stale"):
            # fleet.json is a live TELEMETRY feed, written continuously only
            # while a hive harness loop runs. The roster itself is registry.json,
            # written when the agent set changes, not on a timer, so a stable
            # fleet accrues unbounded fleet.json age while the roster stays
            # accurate (openaliceStatus.js: "roster age is reported, not gating";
            # rosterGate.test.js pins that an aged-but-accurate roster must NOT
            # downgrade a healthy fleet). Degrade only when the roster file
            # itself is unreadable or empty; a frozen telemetry feed is a note,
            # not a roster failure.
            _reg_agents = None
            try:
                with open(os.path.join(HIVE, "registry.json"), encoding="utf-8") as _fh:
                    _reg_agents = (json.load(_fh) or {}).get("agents")
            except Exception:
                _reg_agents = None
            if isinstance(_reg_agents, (dict, list)) and _reg_agents:
                ok.append("roster file readable (registry.json: %d agents); telemetry "
                          "feed fleet.json is %.1fh old (reported, not gating)"
                          % (len(_reg_agents), age / 3600.0))
            else:
                degradations.append({
                    "check": "roster is current",
                    "detail": "fleet.json telemetry is %.1fh old AND registry.json is "
                              "unreadable or empty, so roster currency cannot be "
                              "corroborated" % (age / 3600.0),
                })
        else:
            ok.append("roster current (age=%.0fs)" % age)

    # 4. All twelve floors, each stating manager liveness rather than assuming it.
    #
    # Real source is /api/summary.floors; /api/floors is accepted as a fallback
    # so either shape satisfies the invariant.
    floors: List[Dict[str, Any]] = []
    source = ""
    code, body = fetch("/api/summary")
    if code == 200 and isinstance(body, dict) and body.get("floors"):
        floors = body["floors"]
        source = "/api/summary.floors"
    else:
        code, body = fetch("/api/floors")
        if code == 200:
            if isinstance(body, dict):
                floors = body.get("floors") or []
            elif isinstance(body, list):
                floors = body
            source = "/api/floors"
    if floors:
        _ids = {str(f.get("floor") or f.get("id") or "").lower()
                for f in floors if isinstance(f, dict)}
        _ids = {i for i in _ids if _FLOOR_ID_RE.match(i)}
        _viol, _note = check_floor_monotonic(_ids)
        for _v in _viol:
            missing.append({"check": "floors never deleted", "detail": _v})
        if not _viol:
            ok.append("never-delete rule: %s" % _note)

        ok.append("floor source %s -> %d floors" % (source, len(floors)))
        seen = {str(f.get("floor") or f.get("id") or "").lower() for f in floors if isinstance(f, dict)}
        expected = {"f%d" % i for i in range(1, 13)}
        absent = sorted(expected - seen)
        if absent:
            missing.append({"check": "F1-F12 present", "detail": "missing floors: %s" % ", ".join(absent)})
        else:
            ok.append("F1-F12 all present")
        # Every floor must carry a real liveness fact, not just a name.
        no_liveness = [
            str(f.get("floor") or f.get("id"))
            for f in floors if not floor_liveness_evidence(f)
        ]
        if no_liveness:
            missing.append({
                "check": "floor liveness evidence",
                "detail": "floors with no liveness evidence: %s" % ", ".join(no_liveness[:12]),
            })
        else:
            ok.append("all %d floors carry liveness evidence" % len(floors))
        # A floor may not claim health on the strength of existing.
        unevidenced = [
            "%s (%s)" % (f.get("floor") or f.get("id"), floor_health_claim(f))
            for f in floors
            if floor_health_claim(f) and not floor_liveness_evidence(f)
        ]
        if unevidenced:
            missing.append({
                "check": "no unevidenced health",
                "detail": "floors claiming health with no evidence: %s" % ", ".join(unevidenced[:12]),
            })
        else:
            ok.append("no floor claims health without evidence")
    else:
        missing.append({
            "check": "floor view",
            "detail": "no floors in /api/summary.floors or /api/floors (http %s)" % code,
        })

    # 6b. A reported floor must carry real state, not just the keys.
    #
    # The existing floor checks test for the PRESENCE of a liveness field, which
    # a null satisfies: /api/summary.floors returns 18 rows that all carry a null
    # state, and 6 of them are not floors at all but agent-group labels
    # (command, office, operations, polymarket, specialists, workers). Those
    # belong in the agent view. Counting them as evidenced floors is a false pass.
    nulls, nonfloors, floor_source = scan_floor_rows()
    if nulls or nonfloors:
        parts = []
        if nulls:
            parts.append("%d row(s) carry a null state and are not evidenced floors (%s)"
                         % (len(nulls), ", ".join(nulls[:4])))
        if nonfloors:
            parts.append("%d of them are not floors at all - agent-group labels (%s) "
                         "that belong in the agent view, not the floor view"
                         % (len(nonfloors), ", ".join(nonfloors[:6])))
        degradations.append({
            "check": "reported floors carry real state",
            "detail": "%s: %s. A key that exists but holds null is not evidence, and "
                      "must not be counted as a verified floor."
                      % (floor_source, "; ".join(parts)),
        })
    else:
        ok.append("every reported floor carries a non-null state and liveness")

    # 5. Terminals must be attributed to hosts and aged, not presented flat.
    code, body = fetch("/api/terminals")
    if code == 200 and isinstance(body, dict):
        hosts = body.get("hosts")
        if not isinstance(hosts, list) or not hosts:
            missing.append({"check": "terminal view", "detail": "no hosts reported"})
        else:
            ok.append("terminal hosts=%d" % len(hosts))
    elif code == 200:
        missing.append({"check": "terminal view", "detail": "no hosts list"})

    # 6. No real credential may be served over the API.
    #
    # Read endpoints are unauthenticated, so anything the office returns is
    # readable by any client that can reach the port. This pattern set is
    # deliberately narrow and skips the published example credentials: a broad
    # scanner flagged 87 hits on this very API and every one was either a
    # filesystem path or documentation text, which is how a noisy check gets
    # ignored. High confidence only, and the AWS example key is excluded.
    leaks, scanned = scan_for_secrets()
    if leaks:
        missing.append({
            "check": "no credentials in API payloads",
            "detail": "%d possible secret(s): %s" % (
                len(leaks), ", ".join("%s:%s" % (k, v[:12]) for k, v in leaks[:4])),
        })
    else:
        ok.append("no credential patterns across %d API payload(s)" % scanned)

    # 7b. State claims must be corroborated. "working" needs evidence of work,
    #     not merely a recent heartbeat; a health word needs evidence of being up.
    #     Measured against the live payload before being asserted -- see
    #     scan_unbacked_state_claims -- so this is a real invariant, not a guess.
    unbacked_working, unbacked_healthy, state_checked = scan_unbacked_state_claims()
    if state_checked == 0:
        degradations.append({
            "check": "agent state corroboration",
            "detail": ("NOT VERIFIED: 0 agent state claims were assessable, so "
                       "neither working nor healthy could be corroborated. The "
                       "/api/agents status field likely changed. This is not a pass."),
        })
    if unbacked_working:
        degradations.append({
            "check": "working state is corroborated",
            "detail": ("%d agent(s) report a working state with no task, tool or "
                       "recent activity: %s" % (len(unbacked_working),
                                                 ", ".join(unbacked_working[:8]))),
        })
    elif state_checked:
        ok.append("every working claim carries evidence of work (%d state claim(s) checked)"
                  % state_checked)
    if unbacked_healthy:
        degradations.append({
            "check": "healthy claim is corroborated",
            "detail": ("%d agent(s) report healthy with no session, heartbeat, process "
                       "or task: %s" % (len(unbacked_healthy),
                                        ", ".join(unbacked_healthy[:8]))),
        })
    elif state_checked:
        ok.append("no agent claims healthy without evidence")

    # 8. Truthfulness defect: the HUD must not withhold verification it can
    #    perform. An agent whose processId is a live PID is verifiable, so
    #    reporting it as unverified is a false negative - a lie in the safe
    #    direction, and just as wrong as the optimistic kind.
    #
    #    This currently fails on this machine (58/58 agents carry
    #    processVerified=false while all 58 PIDs are alive). It is reported as
    #    a degradation rather than a hard failure, because the service is up and
    #    every view answers; it is serving something untrue, not nothing.
    _w, _c, _t, _u = scan_withheld_verification()
    _verdict, _why = classify_verification(_w, _c, _t, _u)
    if _verdict == "ok":
        ok.append(_why)
    else:
        degradations.append({
            "check": "agent process verification",
            "detail": _why,
        })

    # Floors must be observable. A view that cannot be read cannot show that any
    # floor still exists, and an unobservable floor is indistinguishable from a
    # deleted one.
    if not floors:
        missing.append({
            "check": "floors observable (never-delete rule)",
            "detail": "no floor view available (tried /api/summary.floors and /api/floors); "
                      "cannot prove any floor still exists",
        })

    # No two floors should continuously do the same work without a real
    # dependency or an explicit handoff. Measured from the declared text.
    _ranked = find_floor_overlap()
    _dupes = [t for t in _ranked if t[2] >= 0.34]
    if _dupes:
        degradations.append({
            "check": "floors have distinct responsibilities",
            "detail": "%d floor pair(s) declare materially overlapping work: %s" % (
                len(_dupes),
                "; ".join("%s/%s %.0f%% (%s)" % (a, b, j * 100, ", ".join(sh[:4]))
                          for a, b, j, sh in _dupes[:3])),
        })
    if _ranked:
        _a, _b, _j, _sh = _ranked[0]
        ok.append("closest floor pair: %s/%s at %.0f%% shared vocabulary (%s)"
                  % (_a, _b, _j * 100, ", ".join(_sh[:4])))
        if not _dupes:
            ok.append("no floor pair crosses the 34%% duplication threshold")

    return missing, degradations, ok


# --------------------------------------------------------------------------
# Floor permanence (operator rule) and floor distinctness.
#
# The route behind these was removed repeatedly while lib/floor_health.py kept
# computing every floor correctly, so the floor view itself is treated as a
# thing that can be wrongly deleted, not just an endpoint that can 404.
# --------------------------------------------------------------------------
_FLOOR_ID_RE = re.compile(r"^f\d+$")
_STOPWORDS = set("""a an and are as at be by for from has have in is it its of on or that the to
with your you watch monitor detect report prompt when own floor managers state health
metrics issues detected""".split())
_BOILERPLATE = [re.compile(r"^report\b.*\bto\s+office\s+manager\b", re.I),
                re.compile(r"^prompt\s+specialists\b", re.I)]


def load_floor_ledger():
    data = load(FLOOR_LEDGER)
    seen = data.get("floors_ever_seen")
    return set(seen) if isinstance(seen, list) else set()


def save_floor_ledger(current, ledger, first_seen):
    merged = sorted(ledger | set(current))
    first = dict(first_seen)
    for f in merged:
        first.setdefault(f, time.strftime("%Y-%m-%dT%H:%M:%S"))
    save(FLOOR_LEDGER, {
        "floors_ever_seen": merged,
        "count": len(merged),
        "policy": "floors are permanent; growth is additive only; never delete",
        "first_seen": first,
        "updated": time.strftime("%Y-%m-%dT%H:%M:%S"),
    })
    return merged


def check_floor_monotonic(current):
    """Operator rule: floors are never deleted; only added.

    A floor in the ledger that is now missing is a deletion and is reported as a
    hard failure with its first-seen date, so the loss is traceable.
    """
    ledger = load_floor_ledger()
    current = set(current)
    if not ledger:
        save_floor_ledger(current, ledger, {})
        return [], "floor ledger initialised with %d floor(s)" % len(current)
    deleted = sorted(ledger - current)
    added = sorted(current - ledger)
    if deleted:
        first = load(FLOOR_LEDGER).get("first_seen", {})
        detail = ", ".join("%s (first seen %s)" % (d, first.get(d, "?")) for d in deleted[:6])
        return (["floor(s) DELETED: %s" % detail],
                "ledger has %d, %d present, %d deleted" % (len(ledger), len(current), len(deleted)))
    save_floor_ledger(current, ledger, {})
    if added:
        return [], ("%d floor(s) added (%s); ledger now %d, no deletions"
                    % (len(added), ", ".join(added[:6]), len(ledger | current)))
    return [], "all %d ledgered floor(s) present, none deleted" % len(ledger)


def floor_responsibilities():
    """Declared responsibilities per floor, read from identity.md."""
    out = {}
    for i in range(1, 13):
        path = os.path.join(HIVE, "agents", "F%d" % i, "identity.md")
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                txt = fh.read()
        except OSError:
            continue
        resp, grab = [], False
        for line in txt.splitlines():
            t = line.strip()
            if t.lower().startswith("your responsibilities"):
                grab = True
                continue
            if grab:
                if t.startswith("- "):
                    resp.append(t[2:].strip())
                elif t and not t.startswith("-"):
                    break
        if resp:
            out["f%d" % i] = resp
    return out


def find_floor_overlap():
    """Ranked overlap of declared responsibilities, boilerplate removed.

    Every identity.md ends with the same two boilerplate lines; left in, they make
    all twelve floors look identical and the measurement says nothing. The
    nearest pair is always reported, so "nothing overlaps" is never asserted
    without the number behind it.
    """
    words = {}
    for f, items in floor_responsibilities().items():
        toks = set()
        for it in items:
            cleaned = it
            for pat in _BOILERPLATE:
                cleaned = pat.sub("", cleaned)
            toks |= {w for w in re.findall(r"[a-z]+", cleaned.lower())
                     if len(w) > 3 and w not in _STOPWORDS}
        if toks:
            words[f] = toks
    pairs = []
    keys = sorted(words)
    for a in range(len(keys)):
        for b in range(a + 1, len(keys)):
            sa, sb = words[keys[a]], words[keys[b]]
            if not sa or not sb:
                continue
            jac = len(sa & sb) / float(len(sa | sb))
            if jac > 0.05:
                pairs.append((keys[a], keys[b], jac, sorted(sa & sb)))
    pairs.sort(key=lambda t: -t[2])
    return pairs


def main() -> int:
    state = load(STATE)
    last = state.get("last_check") or 0
    if time.time() - last < THROTTLE_SEC:
        print(json.dumps({"skipped": True, "reason": "throttled"}))
        return 0

    missing, degradations, ok = check()
    if missing:
        status = "regressed"
    elif degradations:
        status = "degraded"
    else:
        status = "ok"
    report = {
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "status": status,
        "passed": ok,
        "missing": missing,
        "degradations": degradations,
    }

    prev = state.get("status")
    if not load(BASELINE):
        save(BASELINE, report)
        log("HUD GUARD baseline written: status=%s (%d passed, %d missing, %d degraded)"
            % (status, len(ok), len(missing), len(degradations)))
        print(json.dumps({"baseline_written": True, **report}, indent=2))
    elif prev and prev != status:
        # A transition in either direction is an event worth a line: an entry
        # into a bad state, a worsening between bad states, and a recovery.
        # The original only logged ok -> not-ok, so once the guard went red it
        # never wrote again and the log looked dead while the guard ran fine.
        offenders = missing + degradations
        level = "RECOVERED" if status == "ok" else status.upper()
        msg = "HUD GUARD %s: %s" % (level, "; ".join(
            "%s (%s)" % (m["check"], m["detail"]) for m in offenders
        ) or "all checks pass")
        log(msg)
        print(json.dumps({"ALERT": msg, **report}, indent=2))
    else:
        # Steady state still gets one compact line per check, so the log itself
        # is evidence the guard is alive. A guard that only ever logs bad news
        # is indistinguishable from a dead one.
        log("HUD GUARD %s: %d passed, %d missing, %d degraded"
            % (status.upper(), len(ok), len(missing), len(degradations)))
        print(json.dumps(report, indent=2))

    save(STATE, {"last_check": time.time(), "status": status,
                 "missing": missing, "degradations": degradations})
    return 0 if status == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
