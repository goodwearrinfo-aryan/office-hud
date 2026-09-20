# Office HUD

Your own agent office — a live HUD over an `openalice-fleet` hive.  
Reads `~/openalice-fleet/hive/` (read-only) and serves a dark mission-control dashboard at `http://localhost:4747`.

## Floors

| Floor | What you see |
|---|---|
| **F1 — Sessions** | Runtime map: provider, cwd, cwdValid, lastSeen for every agent |
| **F2 — Ledger** | `log.jsonl` timeline — spawns, messages, archives, filterable |
| **F3 — Agents** ★ | Isometric pixel office: Michael in the corner office + 7 workers at pods. Monitor color = live status. Click any desk → drawer with identity.md, memory.md, inbox/outbox |
| **F4 — Projects** | Agents grouped by their cwd (worktree) |
| **F5 — Executive HQ** | KPI cards (active/archived, backlog, cost, events/24h, breakers), sparkline, roster table |

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

## Data (read-only)

The server **never writes** to your hive. It reads:

- `fleet.json`, `registry.json` — live agent status
- `log.jsonl` — event timeline
- `tasks.json` — task list
- `agents/*/identity.md`, `memory.md`, `inbox/*.json`, `outbox/*.json`

## Requirements

- Node 18+
- An `openalice-fleet` hive at `~/openalice-fleet/hive/` (or set `OFFICE_HUD_HIVE`)

## License

MIT