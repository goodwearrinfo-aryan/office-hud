// office-hud server — read-only window into an openalice-fleet hive.
// Serves REST + SSE (live fs.watch) and the built web app. Never writes to the hive.

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 4747);
const HIVE = process.env.OFFICE_HUD_HIVE || path.join(os.homedir(), 'openalice-fleet', 'hive');

const app = express();
app.use(express.json());

// ---------- hive readers (defensive: hive may be missing or mid-write) ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJsonl(file, limit) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { /* skip partial line */ }
    }
    return limit ? out.slice(-limit) : out;
  } catch {
    return [];
  }
}

function listMessages(dir, limit = 50) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .slice(-limit)
      .map(f => {
        const msg = readJson(path.join(dir, f), null);
        if (!msg) return null;
        msg._file = f;
        return msg;
      })
      .filter(Boolean)
      .reverse(); // newest first
  } catch {
    return [];
  }
}

function hiveStatus() {
  const exists = fs.existsSync(HIVE);
  return { hive: HIVE, present: exists };
}

function getFleet() {
  return readJson(path.join(HIVE, 'fleet.json'), { ts: null, agents: [] });
}

function getRegistry() {
  return readJson(path.join(HIVE, 'registry.json'), { godId: null, agents: {} });
}

function mergedAgents() {
  const fleet = getFleet();
  const reg = getRegistry();
  const fleetById = Object.fromEntries((fleet.agents || []).map(a => [a.id, a]));
  const byId = new Map();

  for (const [id, a] of Object.entries(reg.agents || {})) {
    byId.set(id, { ...a, ...(fleetById[id] || {}) });
  }
  for (const a of fleet.agents || []) {
    if (!byId.has(a.id)) byId.set(a.id, a);
  }

  return [...byId.values()].map(a => {
    const archived = !!a.archived;
    const breaker = a.breaker || (archived ? 'offline' : 'healthy');
    let display = 'idle';
    if (archived) display = 'offline';
    else if (breaker !== 'healthy') display = 'breaker';
    else if (a.status === 'busy' || a.status === 'working' || (a.lastActiveSecAgo != null && a.lastActiveSecAgo < 120)) display = 'busy';
    return {
      id: a.id,
      name: a.name || a.id,
      role: a.role || 'worker',
      isGod: !!a.isGod,
      provider: a.provider || null,
      cwd: a.cwd || null,
      cwdValid: a.cwdValid !== false,
      status: a.status || 'idle',
      display,
      archived,
      breaker,
      tokens: a.tokens ?? 0,
      usd: a.usd ?? 0,
      sessionUsd: a.sessionUsd ?? 0,
      lastTool: a.lastTool || null,
      lastActiveSecAgo: a.lastActiveSecAgo ?? null,
      inboxBacklog: a.inboxBacklog ?? 0,
      onHold: !!a.onHold,
      lastSeen: a.lastSeen ?? null,
    };
  }).sort((a, b) => (b.isGod - a.isGod) || a.id.localeCompare(b.id));
}

// ---------- routes ----------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ...hiveStatus(), ts: Date.now() });
});

app.get('/api/summary', (_req, res) => {
  res.json({ ...hiveStatus(), fleet: getFleet(), godId: getRegistry().godId, agents: mergedAgents() });
});

app.get('/api/agents', (_req, res) => {
  res.json({ agents: mergedAgents() });
});

app.get('/api/agents/:id', (req, res) => {
  const id = String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '');
  const dir = path.join(HIVE, 'agents', id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'agent not found', id });
  res.json({
    agent: mergedAgents().find(a => a.id === id) || { id },
    identity: readText(path.join(dir, 'identity.md')),
    memory: readText(path.join(dir, 'memory.md')),
    inbox: listMessages(path.join(dir, 'inbox')),
    outbox: listMessages(path.join(dir, 'outbox')),
  });
});

app.get('/api/ledger', (req, res) => {
  const kind = req.query.kind ? String(req.query.kind) : null;
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  let events = readJsonl(path.join(HIVE, 'log.jsonl'), 2000);
  if (kind) events = events.filter(e => e.kind === kind);
  res.json({ events: events.reverse().slice(0, limit) });
});

app.get('/api/tasks', (_req, res) => {
  res.json(readJson(path.join(HIVE, 'tasks.json'), { tasks: [] }));
});

// ---------- SSE: push "changed" whenever the hive moves ----------

const sseClients = new Set();
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('event: hello\ndata: {}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

let broadcastTimer = null;
function broadcast() {
  for (const res of sseClients) {
    try { res.write('event: change\ndata: {}\n\n'); } catch { /* client gone */ }
  }
}
try {
  fs.watch(HIVE, { recursive: true }, () => {
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(broadcast, 400);
  });
} catch (e) {
  console.warn('[office-hud] fs.watch unavailable:', e.message);
}

// ---------- static web app ----------

const dist = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`[office-hud] hive: ${HIVE} (${fs.existsSync(HIVE) ? 'found' : 'MISSING'})`);
  console.log(`[office-hud] open → http://localhost:${PORT}`);
});
