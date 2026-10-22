#!/usr/bin/env python3
"""Floor health probe for the Office HUD.

This script is called by the health probe to provide evidence-based floor states.
It reads the hive's fleet.json, sessions.json, and tasks.json to determine
the real state of each floor.

Output: JSON array of floor objects, each with:
  - floor: floor id (f1, f2, ..., f12)
  - manager: manager agent id (F1, F2, ...)
  - state: WORKING | IDLE | FAILED | STOPPED | DEGRADED | UNKNOWN
  - reason: human-readable reason for the state
  - manager_alive: boolean
  - task_counts: {QUEUED: n, IN_PROGRESS: n, COMPLETE: n, FAILED: n, ...}
  - current_task: current task id or null
  - last_activity: ISO timestamp or null
  - worker_count: int
  - failed_workers: int
  - stalled_tasks: int
"""
import json
import os
import sys
import time
from pathlib import Path

HIVE = os.environ.get("OPENALICE_HIVE") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".."
)


def read_json(path, fallback=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return fallback


def timestamp_ms(value):
    """Parse ISO timestamp to milliseconds since epoch."""
    if not value:
        return None
    try:
        from datetime import datetime
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return int(dt.timestamp() * 1000)
    except (ValueError, TypeError):
        return None


def is_process_alive(pid):
    """Check if a process is alive by PID."""
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def records(doc, key):
    """Return the row list from a hive doc, whichever envelope shape it has.

    hive/*.json is rewritten by concurrent agents, and a bare top-level list has
    been left behind often enough to raise 323 AttributeErrors out of this probe
    in one day. A probe that dies prints nothing, so its consumer reads the
    absence as health rather than as a failure.
    """
    if isinstance(doc, list):
        return doc
    if isinstance(doc, dict):
        rows = doc.get(key)
        return rows if isinstance(rows, list) else []
    return []


def resolve_floor(task, floor_by_agent):
    """Resolve the floor a task belongs to.

    Task rows carry `assigned_agent`; they do not carry `floorId`/`floor_id`.
    Matching only the explicit fields kept every floor at zero queued and zero
    stalled no matter how much work the store held, so the attribution falls
    back to the roster. An explicit field still wins, for producers that write
    one.
    """
    floor = task.get("floorId") or task.get("floor_id") or ""
    if not floor:
        floor = floor_by_agent.get(str(task.get("assigned_agent") or "").lower(), "")
    return str(floor).lower()


def main():
    hive = os.environ.get("OPENALICE_HIVE") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), ".."
    )

    agents = records(read_json(os.path.join(hive, "fleet.json"), {}), "agents")
    sessions_list = records(read_json(os.path.join(hive, "sessions.json"), {}), "sessions")
    tasks_list = records(read_json(os.path.join(hive, "tasks.json"), {}), "tasks")

    # Build session map by agent_id (case-insensitive)
    session_map = {}
    for s in sessions_list:
        agent_id = s.get("agent_id")
        if agent_id:
            key = agent_id.lower()
            if key not in session_map:
                session_map[key] = s
            else:
                existing = session_map[key]
                hb1 = timestamp_ms(s.get("last_heartbeat"))
                hb2 = timestamp_ms(existing.get("last_heartbeat"))
                if hb1 and hb2 and hb1 > hb2:
                    session_map[key] = s

    # Merge remote-host agent sessions carrying host-verified process evidence.
    # hive/remote/<host>/terminals.json holds each remote host's collected
    # agent sessions; that host's collector stamps process_alive after checking
    # the PID directly on its own machine. A remote PID string alone is a claim,
    # not evidence — process_alive from a fresh host doc is the trusted check.
    # Only fresh docs are consulted, sessions older than the stale window are
    # skipped, and fresher local evidence always wins.
    remote_dir = os.path.join(hive, "remote")
    try:
        remote_hosts = os.listdir(remote_dir)
    except OSError:
        remote_hosts = []
    for host_name in remote_hosts:
        doc = read_json(os.path.join(remote_dir, host_name, "terminals.json"))
        if not isinstance(doc, dict) or not isinstance(doc.get("agent_sessions"), list):
            continue
        doc_fresh = (time.time() * 1000 - (timestamp_ms(doc.get("collected_at")) or 0)) / 1000 <= 300
        if not doc_fresh:
            continue
        for s in doc["agent_sessions"]:
            if not isinstance(s, dict) or not s.get("agent_id"):
                continue
            age = s.get("heartbeat_age_sec")
            if age is None:
                hb = timestamp_ms(s.get("last_heartbeat"))
                age = (time.time() * 1000 - hb) / 1000 if hb else None
            if age is None or age > 300:
                continue
            key = str(s["agent_id"]).lower()
            existing = session_map.get(key)
            remote_hb = timestamp_ms(s.get("last_heartbeat")) or 0
            if existing:
                existing_hb = timestamp_ms(existing.get("last_heartbeat")) or 0
                if existing_hb >= remote_hb:
                    continue
            merged = dict(s)
            merged["heartbeat_age_sec"] = int(max(0, age))
            merged["remote_host"] = host_name
            merged["process_liveness"] = (
                "remote-verified" if s.get("process_alive") is True and s.get("pid_verified_by")
                else "remote-unverified"
            )
            session_map[key] = merged

    # Build agent map by floor, and the agent id -> floor lookup tasks resolve
    # through. Both must exist before counting, so this runs first now.
    agents_by_floor = {}
    floor_by_agent = {}
    for agent in agents:
        floor = agent.get("floor", "")
        agent_id = agent.get("id")
        if floor and agent_id:
            floor_by_agent[str(agent_id).lower()] = str(floor).lower()
        if floor:
            if floor not in agents_by_floor:
                agents_by_floor[floor] = []
            agents_by_floor[floor].append(agent)

    # Build task counts by floor
    task_counts_by_floor = {}
    for task in tasks_list:
        floor = resolve_floor(task, floor_by_agent)
        if not floor:
            continue
        status = task.get("status", "UNKNOWN")
        if floor not in task_counts_by_floor:
            task_counts_by_floor[floor] = {"QUEUED": 0, "IN_PROGRESS": 0, "COMPLETE": 0, "FAILED": 0, "QUARANTINED": 0, "REVIEW": 0, "BLOCKED": 0}
        task_counts_by_floor[floor][status] = task_counts_by_floor[floor].get(status, 0) + 1

    # Determine floor states
    FLOOR_IDS = [f"f{i}" for i in range(1, 13)]
    floors = []

    for floor_id in FLOOR_IDS:
        # Get agents on this floor
        agents_on_floor = agents_by_floor.get(floor_id, [])
        
        # Get manager (first agent on floor, typically the manager)
        manager = agents_on_floor[0] if agents_on_floor else None
        manager_id = manager.get("id") if manager else f"F{floor_id[1:]}"
        
        # Get session for manager
        session = session_map.get(manager_id.lower()) if manager else None
        
        # Check if manager process is alive. A host-verified process_alive flag
        # (stamped by the remote host's collector after checking the PID on its
        # own machine) is the trusted reading; the local is_process_alive check
        # of a remote PID would always read False, fabricating an outage.
        manager_alive = False
        if session:
            if session.get("process_alive") is not None:
                manager_alive = bool(session.get("process_alive"))
            elif session.get("process_id"):
                manager_alive = is_process_alive(session.get("process_id"))
        
        # Get agent task
        current_task = session.get("current_task_id") if session else None
        
        # Get last activity
        last_activity = session.get("last_heartbeat") if session else None
        
        # Get task counts for this floor
        task_counts = task_counts_by_floor.get(floor_id, {
            "QUEUED": 0, "IN_PROGRESS": 0, "COMPLETE": 0, "FAILED": 0, 
            "QUARANTINED": 0, "REVIEW": 0, "BLOCKED": 0
        })
        
        # Ensure all statuses are present
        for status in ["QUEUED", "IN_PROGRESS", "COMPLETE", "FAILED", "QUARANTINED", "REVIEW", "BLOCKED"]:
            if status not in task_counts:
                task_counts[status] = 0
        
        # Count workers on this floor
        worker_count = len(agents_on_floor)
        failed_workers = 0
        stalled_tasks = 0
        
        for agent in agents_on_floor:
            worker_session = session_map.get(agent["id"].lower())
            if not worker_session:
                failed_workers += 1
            elif worker_session.get("status") == "STALE":
                failed_workers += 1
        
        # Count stalled tasks
        for task in tasks_list:
            if resolve_floor(task, floor_by_agent) == floor_id:
                if task.get("status") in ("IN_PROGRESS", "STALLED"):
                    stalled_tasks += 1
        
        # Determine overall floor state
        state = "UNKNOWN"
        reason = "no session data"
        manager_alive_bool = False
        
        # Find session for any agent on this floor
        floor_session = None
        for agent in agents_on_floor:
            agent_session = session_map.get(agent["id"].lower())
            if agent_session:
                floor_session = agent_session
                break
        
        if floor_session:
            # A session record existing is not a process being alive. This line
            # asserted True on mere presence, so a 33-hour-old record whose PID
            # is gone on every host still reported a live floor manager. Trust a
            # host-stamped flag when present, otherwise check the PID here.
            if floor_session.get("process_alive") is not None:
                manager_alive_bool = bool(floor_session.get("process_alive"))
            elif floor_session.get("process_id"):
                manager_alive_bool = is_process_alive(floor_session.get("process_id"))
            hb_age = (time.time() * 1000 - timestamp_ms(floor_session.get("last_heartbeat"))) / 1000 if floor_session.get("last_heartbeat") else 0
            if hb_age > 300:  # 5 minutes
                state = "STALE"
                reason = "heartbeat stale"
            else:
                state = "WORKING"
                reason = "active session"
        else:
            state = "UNKNOWN"
            reason = "no session"
        
        # Override based on agent presence
        if not agents_on_floor:
            state = "OFFLINE"
            reason = "no agents on floor"
        elif state == "STALE":
            pass  # already set
        elif task_counts.get("IN_PROGRESS", 0) > 0:
            state = "WORKING"
            reason = "tasks in progress"
        elif task_counts.get("QUEUED", 0) > 0:
            state = "IDLE"
            reason = "queued tasks, no active work"
        else:
            state = "IDLE"
            reason = "no active tasks"
        
        floors.append({
            "floor": floor_id,
            "manager": manager_id,
            "state": state,
            "reason": reason,
            "manager_alive": manager_alive_bool,
            "task_counts": task_counts,
            "current_task": floor_session.get("current_task_id") if floor_session else None,
            "last_activity": floor_session.get("last_heartbeat") if floor_session else None,
            "worker_count": worker_count,
            "failed_workers": failed_workers,
            "stalled_tasks": stalled_tasks,
        })
    
    print(json.dumps(floors, indent=2))


if __name__ == "__main__":
    main()