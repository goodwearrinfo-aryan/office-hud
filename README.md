# Office HUD

Your own agent office — a live HUD over an `openalice-fleet` hive.  
Reads `~/openalice-fleet/hive/` and serves a dark mission-control dashboard at `http://localhost:4747`.

## Floors

| Floor | What you see |
|---|---|
| **F1 — Sessions** | Runtime map: provider, cwd, cwdValid, lastSeen for every agent |
| **F2 — Ledger** | `log.jsonl` timeline — spawns, messages, archives, filterable |
| **F3 — Agents** ★ | Isometric pixel office: Michael in the corner office + workers at pods. Monitor color = live status. Click any desk → drawer with identity.md, memory.md, inbox/outbox |
| **F4 — Projects** | Agents grouped by their cwd (worktree) |
| **F5 — Executive HQ** | KPI cards (active/archived, backlog, cost, events/24h, breakers), sparkline, roster table |
| **F6 — Trading Lab** | Strategy backtesting UI, equity curves, Sharpe, win rate, profit factor |
| **F7 — Strategy Lab** | Strategy development, parameter search, walk-forward analysis |
| **F8 — Live Trading** | Paper/testnet trading interface, order execution, position monitoring |
| **F9 — 24x7 Ops** | Service health, provider status, adherence logs, launchd services, Polymarket operations |
| **F10 — Knowledge** | Document search, semantic index, graph explorer, communities |
| **F11 — Risk Metrics** | Portfolio risk analytics, VaR, drawdown, exposure, correlation |
| **F12 — Knowledge Graph** | Interactive graph of knowledge nodes and links, community detection |
| **F13 — Time Machine** | Replay recorded event windows from snapshots; on-demand variant for examining specific ranges |
| **F17 — Fleet Floor** | Overview of the entire hive: agent status, worktrees, fleet health, and cross-machine state |
| **F18 — Headroom Section** | Resource monitoring, rate limits, and headroom indicators for the desk floor |

## Quick start

```bash
# 1. install
npm install

# 2. build the web app
npm run build

# 3. run (server serves both API + built web)
npm start

# open http://localhost:4747
```

## Dev mode (hot reload)

```bash
npm run dev
# starts Vite on :5174 (proxies /api → :4747) + Express on :4747
```

## Launcher (macOS)

```bash
# builds a double-clickable Office HUD.app in /Applications
npm run make:app
```

Then press ⌘Space → type "office" → Enter.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4747` | Server port |
| `OFFICE_HUD_HIVE` | `~/openalice-fleet/hive` | Hive directory to read |

## Data

The server reads from the hive:

- `fleet.json`, `registry.json` — live agent status
- `log.jsonl` — event timeline
- `tasks.json` — task list
- `agents/*/identity.md`, `memory.md`, `inbox/*.json`, `outbox/*.json`
- `terminals.json` — shells a human is sitting in, written by
  `bin/push-terminals.sh` → `scripts/collect-terminals.py` on a timer

It writes exactly one file, and only for the spawned-terminal feature below:

- `spawned_terminals.json` — terminals this HUD started

`terminals.json` is **not** written: `collect-terminals.py` rewrites it in full
every 60 seconds, so anything the HUD stored there would be erased on the next
tick. Spawned terminals therefore live in their own file, and the two are
reported separately by `/api/terminals/spawned` (`collected` vs `spawned`).

## Spawned terminals

The HUD can start terminals and watch them, instead of only reporting the shells
you opened yourself.

```bash
# a background terminal — a command with a result, not a session
curl -sX POST localhost:4747/api/terminals/spawn -H 'Content-Type: application/json' \
  -d '{"cmd":"pytest -xvs","cwd":"'"$HOME"'/alpha-system","type":"background"}'

# a tmux terminal — survives a HUD restart, and you can attach to it
curl -sX POST localhost:4747/api/terminals/spawn -H 'Content-Type: application/json' \
  -d '{"cmd":"npm test","cwd":"'"$HOME"'/trading-bot","type":"tmux"}'
tmux attach -t hud_term_<id>

# read output, then stop it
curl -s "localhost:4747/api/terminals/<id>/logs?lines=50"
curl -s "localhost:4747/api/terminals/<id>/follow"     # SSE, streams as it runs
curl -sX POST localhost:4747/api/terminals/<id>/kill
```

| Route | Purpose |
|---|---|
| `GET /api/terminals/spawned` | Collected shells and spawned terminals, kept apart |
| `POST /api/terminals/spawn` | Start one terminal |
| `POST /api/terminals/bulk` | Start many (`{terminals:[...]}`, or orchestrate agents) |
| `GET /api/terminals/:id` | One terminal plus its last 50 log lines |
| `GET /api/terminals/:id/logs` | Tail its output |
| `GET /api/terminals/:id/follow` | Stream its output as SSE until it exits |
| `POST /api/terminals/:id/kill` | Stop it (idempotent) |
| `POST /api/terminals/:id/signal` | `SIGINT`/`SIGTERM`/`SIGKILL`/`SIGHUP` without finalising |
| `POST /api/terminals/reap` | Drop finished terminals and free their logs |
| `GET /api/terminals/health` | Counts, status/type breakdown, log bytes on disk |

Three backends: `background` (detached child, output to a log file), `tmux`
(attachable session), `orchestrate` (one agent per spare git worktree, via
the fleet's own orchestrate scripts), and `remote` (another host, over SSH —
see below).

`orchestrate` reaches `claude --permission-mode bypassPermissions` on a fresh
worktree, so it is only reachable through `POST /api/terminals/bulk` with
`{"mode":"orchestrate", ..., "confirmed": true}` and is refused otherwise.

### One HUD, both machines

The HUD runs on the deployment host. A laptop reaches it through an SSH
forward, and pushes its own state into the deployment host's hive, so the single
dashboard merges both machines:

```
laptop ──push-terminals.sh──▶ mini hive/remote/<laptop>/terminals.json
laptop ──ssh -L 4748────────▶ mini :4747  (the one HUD)
```

`GET /api/terminals` reports the merged view; a host that has gone quiet is
listed and flagged `stale` rather than dropped, because a sleeping laptop is
otherwise indistinguishable from a laptop with no terminals.

### Docking to a peer host

The repositories being worked on may not be on the machine hosting the HUD. The
`remote` backend runs a command on a peer over SSH:

```bash
curl -sX POST localhost:4747/api/terminals/spawn -H 'Content-Type: application/json' \
  -d '{"type":"remote","peer":"laptop","cmd":"git status","cwd":"/Users/aryanagarwal/alpha-system"}'
```

Peers are declared in `hive/terminal_peers.json`. **A host that is not declared
cannot be targeted** — there is no free-form host parameter anywhere in the code.
For each peer set `sshHost` (resolved through `~/.ssh/config` on the HUD's host,
so use a config alias rather than a bare IP) and `cwdPrefixes`, the trees a
remote command may run in — kept separate from this host's own because the two
machines have different home directories.

The command is validated by the same default-deny allowlist, against the peer's
`cwdPrefixes`, with the on-disk existence check skipped because the path does
not exist locally; prefix containment still applies, so the blast radius stays
bounded.

One-time setup, which this feature deliberately does **not** do for you —
establishing trust between machines is an operator decision:

```bash
# 1. give the HUD's host a key the peer accepts (on the PEER)
cat <hud-host-public-key> >> ~/.ssh/authorized_keys

# 2. give the HUD's host a resolvable name for the peer (~/.ssh/config on the HUD host)
Host <alias>
    HostName <peer-tailscale-name-or-ip>
    User <peer-user>
    IdentityFile ~/.ssh/<key>
    IdentitiesOnly yes

# 3. verify non-interactively
ssh -o BatchMode=yes <alias> 'echo ok'
```

`StrictHostKeyChecking` stays `yes` and no keys are installed automatically, so
a peer that is not already trusted fails with an honest error instead of being
quietly trusted. `GET /api/terminals/peers` reports each peer's reachability.

### Security

Spawning a terminal is arbitrary code execution, so the route is layered:

- **Local only.** Uses the Tailscale-aware gate in `server/lib/local_only.js`.
  Tailscale Serve terminates a tailnet connection on this host and then opens a
  *new loopback* connection to the app, so a remote device arrives as
  `127.0.0.1` and a socket-only check would let the whole tailnet spawn
  processes. Proxy headers and non-loopback `X-Forwarded-For` hops are refused.
- **Default-deny commands.** `hive/terminal_allowlist.json` (falling back to the
  built-in defaults in `server/lib/terminal/allowlist.js`). A command runs only
  if a rule names its binary. Shells, `rm`, `sudo`, `curl`, `ssh`, `cat`,
  `npx` and interpreter `-c` forms are denied regardless of the file, and git's
  execution primitives (`-c`, `core.pager`, `config`, `--exec-path`) are refused
  because git would run them.
- **No shell.** Commands are tokenised and executed as an argv array, so `|`,
  `&&`, `;` and `>` are literal arguments rather than operators — and they are
  refused outright as standalone tokens.
- **Bounded cwd.** A terminal can only start under `cwdPrefixes`.
- **No inherited keys.** The child environment is rebuilt from
  `envPassthrough` (PATH, HOME, …) plus explicit extras, so a spawned shell
  never receives this process's provider API keys.
- **Bounded output.** Each log is capped at 10 MB across 3 rotations, so fifty
  terminals cannot fill the disk.

A corrupt `terminal_allowlist.json` falls back to the built-in defaults — never
to allow-all.

### Honesty

A `background` terminal reports its own exit. A `tmux` session cannot: tmux
tears the session down when the command ends and nothing calls back, so a
60-second reconcile loop checks live state and settles the record. Without it a
finished terminal would read `running` until the next restart — a stale-but-green
panel. Records persist to `spawned_terminals.json` and are reconciled on load,
because launchd restarts the HUD within a second of any exit while terminals keep
running.

## Requirements

- Node 18+
- An `openalice-fleet` hive at `~/openalice-fleet/hive/` (or set `OFFICE_HUD_HIVE`)

## License

MIT