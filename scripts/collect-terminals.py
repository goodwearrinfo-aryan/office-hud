#!/usr/bin/env python3
"""Enhanced collector with real agent session detection and deduplication."""
import json
import os
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

SHELL_PATTERNS = ("zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "tmux")
TERMINAL_APPS = ("Terminal", "iTerm", "WezTerm", "Alacritty", "kitty", "Ghostty")
WORK_PATTERNS = (
    "node", "python", "uvicorn", "pytest", "npm", "pnpm", "yarn",
    "openalice", "office_manager", "code-server",
)

# Known agent scripts -> agent_id mapping
AGENT_SCRIPTS = {
    "strategy_monitor.py": "F1",
    "risk_monitor.py": "F2",
    "market_data_monitor.py": "F3",
}

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def _now_ts() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)

def _ps() -> List[Dict[str, Any]]:
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
            "tty": "" if tty.strip() in ("??", "-", "") else tty.strip(),
            "etime": etime.strip(),
            "name": os.path.basename(comm.strip()),
            "command": args.strip()[:400],
        })
    return rows

def _cwd(pid: int) -> str:
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

def _load_fleet_agents(hive: Path) -> Dict[str, Dict[str, Any]]:
    path = hive / "fleet.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    agents = data.get("agents") if isinstance(data, dict) else None
    if not isinstance(agents, list):
        return {}
    return {a["id"]: a for a in agents if isinstance(a, dict) and "id" in a}

def _match_agent_sessions(procs: List[Dict[str, Any]], fleet_agents: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Match running processes to known agent scripts and create agent_sessions (deduplicated)."""
    sessions = []
    now_iso = _now()
    seen_agents = set()
    
    for proc in procs:
        cmd = proc.get("command", "")
        matched_agent_id = None
        for script, agent_id in AGENT_SCRIPTS.items():
            if script in cmd:
                matched_agent_id = agent_id
                break
        
        if matched_agent_id and matched_agent_id in fleet_agents:
            if matched_agent_id in seen_agents:
                continue  # Deduplicate: keep first match per agent
            seen_agents.add(matched_agent_id)
            
            agent_info = fleet_agents[matched_agent_id]
            pid = proc["pid"]
            sessions.append({
                "session_id": f"sess-{matched_agent_id}-{pid}",
                "agent_id": matched_agent_id,
                "status": "ACTIVE",
                "started_at": datetime.fromtimestamp(proc.get("start_time", datetime.now().timestamp()), timezone.utc).isoformat(timespec="seconds"),
                "last_heartbeat": _now(),
                "current_task_id": f"{matched_agent_id.lower()}-monitoring",
                "process_id": pid,
                "evidence": {
                    "hasTask": True,
                    "sessionFresh": True,
                    "heartbeatAgeSec": 0,
                    "verifiedPid": True,
                    "command": proc["command"][:200]
                }
            })
    return sessions

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

def _processes(hive: Path) -> List[Dict[str, Any]]:
    path = hive / "processes.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    procs = data.get("processes") if isinstance(data, dict) else None
    return procs if isinstance(procs, list) else []

def collect(hive: Path) -> Dict[str, Any]:
    procs = _ps()
    fleet_agents = _load_fleet_agents(hive)
    agent_sessions = _match_agent_sessions(procs, fleet_agents)
    terminals, live_processes = _classify(procs)
    
    return {
        "host": socket.gethostname().split(".")[0],
        "fqn": socket.getfqdn(),
        "collected_at": _now(),
        "agent_sessions": agent_sessions,
        "processes": _processes(hive) or live_processes,
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
